# Formulario Abierto de Dinámica y Mecánica Aplicada (Demo)

> Material libre de demostración para probar **Speaking AI Professor** sin exponer apuntes internos universitarios.

## 1. Transferencia longitudinal de carga
- Peso total: $W = m \cdot g$
- Transferencia en aceleración o frenada:
  $$\Delta F_z = \frac{m \cdot a_x \cdot h_{CG}}{L}$$
- Carga en eje delantero en frenada: $F_{z,f} = W_f + \Delta F_z$
- Carga en eje trasero en frenada: $F_{z,r} = W_r - \Delta F_z$

## 2. Sensibilidad a la carga vertical del neumático
- Fuerza lateral máxima: $F_{y,\max} = \mu(F_z) \cdot F_z$
- En neumáticos reales viscoelásticos, $\frac{d\mu}{dF_z} < 0$: al aumentar la carga normal, el coeficiente efectivo de adherencia disminuye.

## 3. Resistencia aerodinámica y balance de potencia
- Fuerza aerodinámica: $F_{\text{aero}} = \frac{1}{2} \rho C_d A V^2$
- Fuerza de rodadura: $F_{\text{rod}} = C_r \cdot m \cdot g$
- Potencia resistente aerodinámica: $P_{\text{aero}} = F_{\text{aero}} \cdot V = \frac{1}{2} \rho C_d A V^3$

## 4. Teorema de Steiner (ejes paralelos)
- Momento de inercia global respecto a un eje paralelo situado a distancia perpendicular $d_\perp$:
  $$I_{\text{global}} = I_{\text{local}} + m \cdot d_\perp^2$$
