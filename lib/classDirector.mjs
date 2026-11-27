export class ClassDirector {
  constructor({ pdfStage, sendClient, dispatchBeat }) {
    this.pdfStage = pdfStage;
    this.sendClient = sendClient;
    this.dispatchBeat = dispatchBeat; // async ({ cueText, visionBase64 }) => void

    this.active = false;
    this.paused = false;
    this.qaPaused = false;
    this.surface = 'pdf'; // 'pdf' | 'canvas'

    this.pdfDoc = null;
    this.pdfId = '';
    this.pdfName = '';
    this.currentPage = 1;
    this.totalPages = 1;
    this.activeBundle = null;

    this.beatsOnPage = 0;
    this.pendingAdvanceToNextPage = false;

    this.problemActive = false;
    this.problemCompleted = false;
    this.problemTitle = '';
    this.problemStepCount = 0;
    this.problemStepsLog = [];

    // Persistent annotations per `${docId}:${page}` so going backwards restores professor drawings
    this.pageAnnotations = new Map();

    // Audio & turn synchronization so auto-advance NEVER cuts off spoken speech
    this.turnDone = true;
    this.audioDrained = true;
    this.sentAudioThisTurn = false;
    this.beatInFlight = false;
    this.advanceTimer = null;
    this.audioDrainGuardTimer = null;
    this.generationId = 0;
  }

  getPublicState() {
    return {
      active: this.active,
      paused: this.paused,
      qaPaused: this.qaPaused,
      surface: this.surface,
      pdfId: this.pdfId,
      pdfName: this.pdfName,
      currentPage: this.currentPage,
      totalPages: this.totalPages,
      problemActive: this.problemActive,
      problemTitle: this.problemTitle,
      problemStepCount: this.problemStepCount,
      hasExampleOnPage: Boolean(this.activeBundle?.hasExampleProblem),
    };
  }

  emitState() {
    this.sendClient({ type: 'class_state', state: this.getPublicState() });
  }

  clearTimers() {
    if (this.advanceTimer) {
      clearTimeout(this.advanceTimer);
      this.advanceTimer = null;
    }
    if (this.audioDrainGuardTimer) {
      clearTimeout(this.audioDrainGuardTimer);
      this.audioDrainGuardTimer = null;
    }
  }

  getAnnotationsFor(docId, page) {
    return this.pageAnnotations.get(`${docId}:${page}`) || [];
  }

  clearAnnotationsFor(docId, page) {
    const key = `${docId || this.pdfId}:${page || this.currentPage}`;
    this.pageAnnotations.set(key, []);
    if (this.activeBundle && (!docId || docId === this.pdfId) && (!page || Number(page) === this.currentPage)) {
      this.sendClient({
        type: 'stage_pdf_annotations',
        data: {
          docId: this.pdfId,
          page: this.currentPage,
          vbW: this.activeBundle.vbW,
          vbH: this.activeBundle.vbH,
          annotations: [],
          newlyAddedCount: 0,
          clearPrevious: true,
        },
      });
    }
  }

  async openPage({ docId, filename, page, delta, reason, emit = true, includeVision = true } = {}) {
    const doc =
      (docId && this.pdfStage.resolvePdfDoc(docId)) ||
      (filename && this.pdfStage.resolvePdfDoc(filename)) ||
      this.pdfDoc ||
      this.pdfStage.resolvePdfDoc();

    if (!doc) {
      return { ok: false, error: 'No PDF found in the current study folder.' };
    }

    const totalPages = await this.pdfStage.getPageCount(doc);
    let targetPage = this.currentPage || 1;
    if (delta != null && Number.isFinite(Number(delta))) {
      targetPage = (this.currentPage || 1) + Math.trunc(Number(delta));
    } else if (page != null && Number.isFinite(Number(page))) {
      targetPage = Math.trunc(Number(page));
    }
    targetPage = Math.max(1, Math.min(totalPages, targetPage));

    const changedPage = !this.pdfDoc || this.pdfDoc.id !== doc.id || this.currentPage !== targetPage;
    const bundle = await this.pdfStage.getPageBundle(doc, targetPage, { includeVision });

    this.pdfDoc = doc;
    this.pdfId = doc.id;
    this.pdfName = doc.name;
    this.currentPage = bundle.page;
    this.totalPages = bundle.totalPages;
    this.activeBundle = bundle;
    this.surface = 'pdf';
    if (changedPage) {
      this.beatsOnPage = 0;
      this.pendingAdvanceToNextPage = false;
    }

    const savedAnnotations = this.getAnnotationsFor(doc.id, bundle.page);

    if (emit) {
      this.sendClient({
        type: 'stage_pdf_page',
        data: {
          docId: bundle.docId,
          name: bundle.name,
          page: bundle.page,
          totalPages: bundle.totalPages,
          imageUrl: bundle.imageUrl,
          pdfUrl: bundle.pdfUrl,
          clientPdfFallback: Boolean(bundle.clientPdfFallback),
          vbW: bundle.vbW,
          vbH: bundle.vbH,
          hasExampleProblem: bundle.hasExampleProblem,
          reason: reason || '',
          annotations: savedAnnotations,
        },
      });
      this.emitState();
    }

    return {
      ok: true,
      docId: bundle.docId,
      filename: bundle.name,
      page: bundle.page,
      totalPages: bundle.totalPages,
      imageUrl: bundle.imageUrl,
      pdfUrl: bundle.pdfUrl,
      clientPdfFallback: Boolean(bundle.clientPdfFallback),
      vbW: bundle.vbW,
      vbH: bundle.vbH,
      hasExampleProblem: bundle.hasExampleProblem,
      problemCues: bundle.cues,
      pageText: bundle.text.slice(0, 3200),
      lineAnchors: bundle.linesPromptSummary,
      visionBase64: bundle.visionBase64,
    };
  }

  annotateCurrentPage({ clear_previous = false, annotations = [] } = {}) {
    if (!this.activeBundle) {
      return { ok: false, error: 'No PDF page is currently open. Call open_pdf_page first.' };
    }

    const { docId, page, vbW, vbH, layout } = this.activeBundle;
    const key = `${docId}:${page}`;
    const existing = clear_previous ? [] : [...(this.pageAnnotations.get(key) || [])];
    const resolvedItems = [];

    for (const raw of Array.isArray(annotations) ? annotations : []) {
      if (!raw || typeof raw !== 'object') continue;
      const kind = String(raw.kind || 'highlight').toLowerCase();
      const color = ['cyan', 'amber', 'emerald', 'rose'].includes(raw.color) ? raw.color : 'amber';
      const item = {
        id: raw.id || `ann-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        kind,
        color,
        label: raw.label ? String(raw.label).slice(0, 95) : '',
        target_text: raw.target_text ? String(raw.target_text) : '',
        snapped: false,
      };

      // Try sub-millimeter text anchor snapping first!
      const anchor = raw.target_text ? this.pdfStage.resolveTextAnchor(layout, raw.target_text) : null;
      if (anchor) {
        item.x = anchor.x;
        item.y = anchor.y;
        item.w = anchor.w;
        item.h = anchor.h;
        item.cx = anchor.cx;
        item.cy = anchor.cy;
        item.snapped = true;
        item.matchedText = anchor.matchedText;
      } else {
        // Explicit normalized coordinates (x in 0..1000, y in 0..vbH or 0..1000)
        const clampX = (v) => Math.max(10, Math.min(vbW - 10, Number(v)));
        const clampY = (v) => Math.max(10, Math.min(vbH - 10, Number(v)));
        if (Number.isFinite(Number(raw.x))) item.x = clampX(raw.x);
        if (Number.isFinite(Number(raw.y))) item.y = clampY(raw.y);
        if (Number.isFinite(Number(raw.w))) item.w = Math.max(16, Math.min(vbW, Number(raw.w)));
        if (Number.isFinite(Number(raw.h))) item.h = Math.max(14, Math.min(vbH, Number(raw.h)));
        if (Number.isFinite(Number(raw.x1))) item.x1 = clampX(raw.x1);
        if (Number.isFinite(Number(raw.y1))) item.y1 = clampY(raw.y1);
        if (Number.isFinite(Number(raw.x2))) item.x2 = clampX(raw.x2);
        if (Number.isFinite(Number(raw.y2))) item.y2 = clampY(raw.y2);
      }

      // Compute clean arrow/callout origin if anchored to text without explicit tail coords
      if ((kind === 'arrow' || kind === 'callout') && item.snapped) {
        if (!Number.isFinite(item.x2)) item.x2 = item.cx;
        if (!Number.isFinite(item.y2)) item.y2 = item.cy;
        if (!Number.isFinite(item.x1)) {
          // Place margin callout neatly on whichever side has more room
          item.x1 = item.cx < vbW * 0.55 ? Math.min(vbW - 110, item.x + item.w + 75) : Math.max(110, item.x - 75);
        }
        if (!Number.isFinite(item.y1)) {
          item.y1 = item.cy > 90 ? item.y - 38 : item.y + item.h + 44;
        }
      }

      // Ensure vectors always have valid endpoints
      if (kind === 'vector') {
        if (!Number.isFinite(item.x1)) item.x1 = item.cx ?? vbW * 0.45;
        if (!Number.isFinite(item.y1)) item.y1 = item.cy ?? vbH * 0.5;
        if (!Number.isFinite(item.x2)) item.x2 = item.x1;
        if (!Number.isFinite(item.y2)) item.y2 = Math.min(vbH - 25, item.y1 + 95);
      }

      // Only push if we have usable geometry
      const hasGeom =
        Number.isFinite(item.x) ||
        (Number.isFinite(item.x1) && Number.isFinite(item.x2));
      if (hasGeom) {
        resolvedItems.push(item);
      }
    }

    const merged = [...existing, ...resolvedItems].slice(-28);
    this.pageAnnotations.set(key, merged);
    this.surface = 'pdf';

    this.sendClient({
      type: 'stage_pdf_annotations',
      data: {
        docId,
        page,
        vbW,
        vbH,
        annotations: merged,
        newlyAddedCount: resolvedItems.length,
        clearPrevious: Boolean(clear_previous),
      },
    });
    this.emitState();

    return {
      ok: true,
      page,
      added: resolvedItems.length,
      snappedCount: resolvedItems.filter((a) => a.snapped).length,
      totalOnPage: merged.length,
    };
  }

  resolvePointerTargetOnPdf(args) {
    if (!this.activeBundle || this.surface !== 'pdf') return args;
    if (args.target_text) {
      const anchor = this.pdfStage.resolveTextAnchor(this.activeBundle.layout, args.target_text);
      if (anchor) {
        return {
          ...args,
          x: anchor.cx,
          y: anchor.cy,
          vbW: this.activeBundle.vbW,
          vbH: this.activeBundle.vbH,
          onPdf: true,
        };
      }
    }
    return {
      ...args,
      vbW: this.activeBundle.vbW,
      vbH: this.activeBundle.vbH,
      onPdf: true,
    };
  }

  startProblemCanvas(args = {}) {
    this.surface = 'canvas';
    this.problemActive = true;
    this.problemCompleted = false;
    this.problemTitle = args.problem_title || 'Resolución paso a paso';
    this.problemStepCount = 0;
    this.problemStepsLog = [];

    const payload = {
      ...args,
      problem_title: this.problemTitle,
      source_pdf: args.source_pdf || this.pdfName || '',
      source_page: args.source_page || this.currentPage || null,
    };
    this.sendClient({ type: 'stage_problem_start', data: payload });
    this.emitState();

    return {
      ok: true,
      surface: 'canvas',
      problem_title: this.problemTitle,
      note: 'Blank Canvas active! Now solve strictly ONE step at a time using append_problem_step (never jump straight to the final formula).',
    };
  }

  appendProblemStep(args = {}) {
    this.surface = 'canvas';
    this.problemActive = true;
    this.problemStepCount += 1;
    const stepNum = Number(args.step_number) || this.problemStepCount;
    const payload = {
      ...args,
      step_number: stepNum,
    };
    this.problemStepsLog.push(`Paso ${stepNum}: ${args.step_title || args.goal || ''}`);
    if (args.is_final_step) {
      this.problemCompleted = true;
    }

    this.sendClient({ type: 'stage_problem_step', data: payload });
    this.emitState();

    return {
      ok: true,
      step_number: stepNum,
      is_final_step: Boolean(args.is_final_step),
      note: args.is_final_step
        ? 'Final step rendered! Summarize physically and call return_to_pdf to return to the slides.'
        : 'Step rendered cleanly. Continue calmly to the next algebraic/physical step.',
    };
  }

  async returnToPdf({ page, summary } = {}) {
    this.problemActive = false;
    this.problemCompleted = false;
    this.problemTitle = '';
    this.surface = 'pdf';

    const targetPage = page || this.currentPage || 1;
    const opened = await this.openPage({ page: targetPage, reason: summary || 'Volviendo al PDF tras resolver el problema' });
    return {
      ...opened,
      returnedFromProblem: true,
      summary: summary || '',
    };
  }

  handleClassProgress({ action, note } = {}) {
    const act = String(action || '').toLowerCase();
    if (act === 'next_page') {
      this.pendingAdvanceToNextPage = true;
    } else if (act === 'resume_class') {
      this.active = true;
      this.paused = false;
      this.qaPaused = false;
      this.emitState();
    } else if (act === 'finished_pdf') {
      this.active = false;
      this.paused = false;
      this.emitState();
    }
    return { ok: true, action: act, note: note || '' };
  }

  async startClass({ pdfId, docId, filename, startPage, startTopic } = {}) {
    this.clearTimers();
    this.generationId++;

    const doc = this.pdfStage.resolvePdfDoc(pdfId || docId || filename);
    if (!doc) {
      this.sendClient({
        type: 'error',
        message: 'No se encontró ningún PDF en esta carpeta. Sube un PDF o cambia de carpeta para usar el Modo Clase.',
      });
      return { ok: false };
    }

    let initialPage = Number(startPage);
    if (!Number.isFinite(initialPage) || initialPage < 1) {
      initialPage = startTopic ? await this.pdfStage.findTopicPage(doc, startTopic) : 1;
    }

    this.active = true;
    this.paused = false;
    this.qaPaused = false;
    this.problemActive = false;
    this.problemCompleted = false;
    this.problemStepCount = 0;
    this.beatsOnPage = 0;
    this.pendingAdvanceToNextPage = false;

    const opened = await this.openPage({
      docId: doc.id,
      page: initialPage,
      reason: startTopic ? `Inicio de clase desde "${startTopic}" (Pág. ${initialPage})` : `Inicio de clase en Página ${initialPage}`,
    });

    if (!opened.ok) return opened;

    this.sendClient({
      type: 'tool_status',
      label: `🎓 Modo Clase iniciado: ${opened.filename} · Página ${opened.page} de ${opened.totalPages}. Interrumpe cuando quieras para preguntar.`,
    });

    const cue = this.buildPageStartCue(opened, { isVeryFirstBeat: true, startTopic });
    await this.triggerBeatNow(cue, opened.visionBase64);
    return { ok: true, page: opened.page, totalPages: opened.totalPages };
  }

  pause(reason = 'Clase pausada') {
    this.clearTimers();
    this.paused = true;
    this.emitState();
    this.sendClient({ type: 'tool_status', label: `⏸ ${reason}. Pulsa "Reanudar Clase" o di "sigue" cuando quieras continuar.` });
  }

  async resume() {
    if (!this.pdfDoc) return;
    this.clearTimers();
    this.active = true;
    this.paused = false;
    this.qaPaused = false;
    this.emitState();
    this.sendClient({ type: 'tool_status', label: `▶ Reanudando clase en Página ${this.currentPage} de ${this.totalPages}...` });
    await this.runNextScheduledBeat();
  }

  stop() {
    this.clearTimers();
    this.generationId++;
    this.active = false;
    this.paused = false;
    this.qaPaused = false;
    this.beatInFlight = false;
    this.emitState();
  }

  /**
   * Called whenever the student speaks or types a message.
   * Returns { handledDirectly: boolean } if it was a pure resume/navigation command.
   */
  async onUserMessage(rawText) {
    this.clearTimers();
    const text = String(rawText || '').trim();
    const norm = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();

    if (!this.active && !this.pdfDoc) {
      return { handledDirectly: false };
    }

    // Pure resume command while paused / after Q&A
    if (
      this.active &&
      (this.paused || this.qaPaused) &&
      /^(ok|vale|bien|perfecto|entendido|claro|gracias|si)?[\s,.!]*(sigue|continua|adelante|proseguir|reanuda|reanudar|seguimos|continue|resume|keep going|go on)[\s,.!]*$/.test(
        norm,
      )
    ) {
      await this.resume();
      return { handledDirectly: true };
    }

    // Otherwise, the student is asking a question or giving an instruction!
    // Pause autonomous lecturing so the professor answers their question naturally without steamrolling.
    if (this.active) {
      this.qaPaused = true;
      this.emitState();
    }
    return { handledDirectly: false };
  }

  onUserInterrupt() {
    this.clearTimers();
    this.generationId++;
    this.beatInFlight = false;
    if (this.active) {
      this.qaPaused = true;
      this.emitState();
    }
  }

  onAudioChunkDispatched() {
    this.sentAudioThisTurn = true;
  }

  onTurnStart() {
    this.turnDone = false;
    this.audioDrained = false;
    this.sentAudioThisTurn = false;
    this.clearTimers();
  }

  onTurnComplete() {
    this.turnDone = true;
    this.beatInFlight = false;
    if (!this.sentAudioThisTurn) {
      this.audioDrained = true;
      this.maybeScheduleNextBeat();
    } else {
      // Wait for browser's `audio_drained` event, with safety fallback if audio playback stalls
      if (this.audioDrainGuardTimer) clearTimeout(this.audioDrainGuardTimer);
      this.audioDrainGuardTimer = setTimeout(() => {
        if (!this.audioDrained && this.turnDone) {
          this.audioDrained = true;
          this.maybeScheduleNextBeat();
        }
      }, 40000);
    }
  }

  onBeatError(message = '') {
    this.clearTimers();
    this.turnDone = true;
    this.audioDrained = true;
    this.beatInFlight = false;
    if (this.active) {
      this.paused = true;
      this.emitState();
    }
    if (message) {
      this.sendClient({
        type: 'tool_status',
        label: `⏸ Clase pausada por error del modelo. Puedes cambiar de modelo o pulsar "Reanudar Clase".`,
      });
    }
  }

  onClientAudioDrained() {
    this.audioDrained = true;
    if (this.audioDrainGuardTimer) {
      clearTimeout(this.audioDrainGuardTimer);
      this.audioDrainGuardTimer = null;
    }
    this.maybeScheduleNextBeat();
  }

  maybeScheduleNextBeat() {
    if (!this.active || this.paused || this.qaPaused || this.beatInFlight) return;
    if (!this.turnDone || !this.audioDrained) return;
    if (this.advanceTimer) return;

    const myGen = this.generationId;
    this.advanceTimer = setTimeout(() => {
      this.advanceTimer = null;
      if (myGen !== this.generationId) return;
      if (!this.active || this.paused || this.qaPaused || this.beatInFlight) return;
      this.runNextScheduledBeat().catch((err) => {
        console.error('[ClassDirector next beat error]', err);
      });
    }, 850);
  }

  async runNextScheduledBeat() {
    if (!this.active || this.paused || this.qaPaused || this.beatInFlight) return;

    // Case 1: Currently solving a problem step-by-step on the Blank Canvas
    if (this.problemActive && !this.problemCompleted) {
      const cue = `[DIRECTOR DE CLASE — RESOLUCIÓN EN LIENZO EN BLANCO · ${this.problemTitle}]
Llevamos ${this.problemStepCount} paso(s) escritos (${this.problemStepsLog.slice(-3).join(' | ') || 'solo planteamiento inicial'}).
Continúa resolviendo el problema POCO A POCO sin saltar pasos:
- Llama a \`append_problem_step\` para escribir EXCLUSIVAMENTE el SIGUIENTE paso lógico (Paso ${this.problemStepCount + 1}), explicando su objetivo, el porqué físico/matemático, la ecuación intermedia y el detalle algebraico.
- Si este paso requiere cálculo numérico, llama PRIMERO a \`verify_math_python\` para comprobar el resultado con 100% de exactitud.
- Si todavía quedan manipulaciones algebraicas antes del resultado final, NO pongas todavía la fórmula final ni marques \`is_final_step: true\`.
- Si ya es el paso final verificado, marca \`is_final_step: true\`.
Explica este paso en voz alta con calma y claridad.`;
      await this.triggerBeatNow(cue, null);
      return;
    }

    // Case 2: Problem just finished -> return smoothly to the PDF page!
    if (this.problemActive && this.problemCompleted) {
      const cue = `[DIRECTOR DE CLASE — VOLVER AL PDF]
Ya hemos terminado de resolver "${this.problemTitle}" en el lienzo en blanco.
Llama ahora a \`return_to_pdf(page: ${this.currentPage})\` para volver a la Página ${this.currentPage} de "${this.pdfName}", comenta en 1-2 frases cómo conecta este resultado con el temario y, si ya está completa esta página, indica \`class_progress(action: "next_page")\` o pasa a la página siguiente con \`open_pdf_page\`.`;
      await this.triggerBeatNow(cue, null);
      return;
    }

    // Case 3: Ready to advance to Page P + 1
    if (this.pendingAdvanceToNextPage || this.beatsOnPage >= 4) {
      if (this.currentPage >= this.totalPages) {
        this.active = false;
        this.emitState();
        await this.triggerBeatNow(
          `[DIRECTOR DE CLASE — FIN DEL PDF] Hemos completado todas las páginas de "${this.pdfName}" (hasta la página ${this.totalPages}). Haz un cierre breve y amable resumiendo los grandes pilares vistos hoy y pregunta al alumno si quiere repasar alguna página o hacer preguntas de examen.`,
          null,
        );
        return;
      }

      const nextPage = this.currentPage + 1;
      const opened = await this.openPage({
        page: nextPage,
        reason: `Avance automático de clase a Página ${nextPage}/${this.totalPages}`,
      });
      if (!opened.ok) return;
      const cue = this.buildPageStartCue(opened, { isVeryFirstBeat: false });
      await this.triggerBeatNow(cue, opened.visionBase64);
      return;
    }

    // Case 4: Continue explaining remaining material on the CURRENT PDF page
    const b = this.activeBundle;
    const exampleReminder = b?.hasExampleProblem
      ? `\nIMPORTANTE: Esta página parece contener un EJEMPLO / PROBLEMA / CÁLCULO. Si aún no lo has resuelto paso a paso en lienzo en blanco, LLAMA A \`start_blank_canvas_problem\` ahora para resolverlo sin prisas.`
      : '';

    const cue = `[DIRECTOR DE CLASE — CONTINUAR PÁGINA ${this.currentPage} de ${this.totalPages} de "${this.pdfName}" (bloque ${this.beatsOnPage + 1})]
Revisa el contenido de esta página para NO saltarte ningún detalle, fórmula, gráfico ni ejemplo.${exampleReminder}
- Si aún queda contenido, alguna ecuación o algún ejemplo pendiente en la Página ${this.currentPage}: sigue explicándolo despacio ahora, anotando sobre el PDF con \`annotate_pdf_page\` (usando \`target_text\` exacto) o pasando al lienzo en blanco con \`start_blank_canvas_problem\` si hay un ejemplo/problema.
- Si YA has explicado absolutamente TODO lo de la Página ${this.currentPage} sin saltarte nada: llama a \`open_pdf_page(page: ${Math.min(this.totalPages, this.currentPage + 1)})\` o \`class_progress(action: "next_page")\` y empieza a explicar la nueva página con naturalidad.`;

    await this.triggerBeatNow(cue, null);
  }

  buildPageStartCue(opened, { isVeryFirstBeat = false, startTopic = '' } = {}) {
    const exampleInstruction = opened.hasExampleProblem
      ? `ATENCIÓN: Se ha detectado un EJEMPLO / PROBLEMA / CÁLCULO en esta página (${opened.problemCues.join(', ')}).
Primero presenta el contexto/enunciado señalándolo sobre el PDF con \`annotate_pdf_page\`, y en cuanto toque resolverlo, LLAMA OBLIGATORIAMENTE a \`start_blank_canvas_problem\` para pasar al LIENZO EN BLANCO y resolverlo paso a paso con \`append_problem_step\` (sin poner la fórmula final directamente).`
      : `Mientras explicas cada idea o ecuación de esta página, llama a \`annotate_pdf_page\` usando \`target_text\` exacto de la lista de líneas inferior para subrayar, rodear, resaltar o poner notas con precisión milimétrica sobre el PDF.`;

    const intro = isVeryFirstBeat
      ? `Comienza la clase en vivo saludando brevemente (1 frase) y arrancando directamente en la Página ${opened.page} de ${opened.totalPages} de "${opened.filename}"${startTopic ? ` (tema inicial: "${startTopic}")` : ''}.`
      : `Hemos pasado a la Página ${opened.page} de ${opened.totalPages} de "${opened.filename}". Enlaza naturalmente con lo anterior y explica esta página sin prisas y sin saltarte nada.`;

    return `[DIRECTOR DE CLASE — PÁGINA ${opened.page}/${opened.totalPages} · "${opened.filename}" · viewBox 0..${opened.vbW} × 0..${opened.vbH}]
${intro}
${exampleInstruction}
Cuando hayas cubierto por completo esta página (si es una diapositiva sencilla puede ser en este mismo bloque; si es densa tómate varios bloques sin prisa), llama a \`class_progress(action: "next_page")\` al terminar de explicarla.

TEXTO LITERAL DE LA PÁGINA ${opened.page}:
${opened.pageText || '(Página principalmente gráfica — observa la imagen adjunta)'}

ANCLAS EXACTAS DE LÍNEAS EN ESTA PÁGINA (pasa cualquier frase de aquí en \`target_text\` de \`annotate_pdf_page\`):
${opened.lineAnchors || '(Sin texto extraíble; usa coordenadas normalizadas sobre la imagen)'}`;
  }

  async triggerBeatNow(cueText, visionBase64) {
    this.beatInFlight = true;
    this.beatsOnPage += 1;
    this.onTurnStart();
    try {
      await this.dispatchBeat({ cueText, visionBase64 });
    } catch (err) {
      this.beatInFlight = false;
      throw err;
    }
  }
}
