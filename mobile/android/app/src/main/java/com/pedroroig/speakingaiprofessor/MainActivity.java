package com.pedroroig.speakingaiprofessor;

import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import java.util.Locale;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                ttsReady = true;
                tts.setLanguage(new Locale("es", "ES"));
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override
                    public void onStart(String utteranceId) {}

                    @Override
                    public void onDone(String utteranceId) {
                        notifyJsTts("__onAndroidTtsDone", utteranceId);
                    }

                    @Override
                    public void onError(String utteranceId) {
                        notifyJsTts("__onAndroidTtsError", utteranceId);
                    }
                });
            }
        });

        if (this.bridge != null && this.bridge.getWebView() != null) {
            WebView webView = this.bridge.getWebView();
            webView.addJavascriptInterface(new NativeTtsBridge(), "AndroidNativeTTS");
            webView.addJavascriptInterface(new NativeUiBridge(), "AndroidNativeUI");
        }
    }

    private void notifyJsTts(String fnName, String utteranceId) {
        runOnUiThread(() -> {
            if (this.bridge != null && this.bridge.getWebView() != null) {
                String js = "window." + fnName + " && window." + fnName + "(" + JSONObject.quote(utteranceId) + ");";
                this.bridge.getWebView().evaluateJavascript(js, null);
            }
        });
    }

    private class NativeTtsBridge {
        @JavascriptInterface
        public void speak(String utteranceId, String text, String langTag, float rate) {
            if (!ttsReady || tts == null || text == null || text.trim().isEmpty()) {
                notifyJsTts("__onAndroidTtsDone", utteranceId);
                return;
            }
            try {
                Locale locale = (langTag != null && langTag.toLowerCase(Locale.ROOT).startsWith("en"))
                    ? Locale.US
                    : new Locale("es", "ES");
                tts.setLanguage(locale);
                tts.setSpeechRate(Math.max(0.6f, Math.min(1.6f, rate)));
                tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
            } catch (Exception e) {
                notifyJsTts("__onAndroidTtsError", utteranceId);
            }
        }

        @JavascriptInterface
        public void stop() {
            if (tts != null) {
                try {
                    tts.stop();
                } catch (Exception ignored) {}
            }
        }
    }

    private class NativeUiBridge {
        @JavascriptInterface
        public void setKeepScreenOn(boolean enabled) {
            runOnUiThread(() -> {
                if (enabled) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }
    }

    @Override
    public void onDestroy() {
        if (tts != null) {
            try {
                tts.stop();
                tts.shutdown();
            } catch (Exception ignored) {}
            tts = null;
        }
        super.onDestroy();
    }
}
