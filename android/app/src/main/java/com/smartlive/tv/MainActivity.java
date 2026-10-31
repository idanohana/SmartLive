package com.smartlive.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * SmartLive TV - a full-screen WebView onto the SmartLive server's /tv page.
 *
 * The page itself handles sign-in, remote navigation and playback; this class
 * only has to point it at the right server, stay out of the way, and hand the
 * remote's BACK button to the page instead of closing the app.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "smartlive";
    private static final String KEY_SERVER = "server";

    /**
     * Where the app points when nothing else is set, so it works straight off
     * a fresh install. The setup screen (MENU key, or any failure to connect)
     * overrides it without needing a new build.
     */
    private static final String DEFAULT_SERVER = "https://smarlive.vercel.app";

    private WebView web;
    private LinearLayout setup;
    private EditText serverInput;
    private TextView setupError;

    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        goImmersive();

        web = findViewById(R.id.web);
        setup = findViewById(R.id.setup);
        serverInput = findViewById(R.id.server);
        setupError = findViewById(R.id.setupError);
        Button save = findViewById(R.id.save);

        configureWebView();

        save.setOnClickListener(v -> {
            String url = normalize(serverInput.getText().toString());
            if (url == null) {
                setupError.setText(R.string.bad_address);
                setupError.setVisibility(View.VISIBLE);
                return;
            }
            prefs().edit().putString(KEY_SERVER, url).apply();
            showSetup(false, null);
            web.loadUrl(url + "/tv");
        });

        String server = prefs().getString(KEY_SERVER, DEFAULT_SERVER);
        serverInput.setText(server);
        web.loadUrl(server + "/tv");
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    /** "192.168.1.20:4321" / "http://box.local:4321/" -> "http://192.168.1.20:4321" */
    private String normalize(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) return null;
        if (!value.startsWith("http://") && !value.startsWith("https://")) value = "http://" + value;
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        if (!value.matches("https?://[^\\s/]+")) return null;
        return value;
    }

    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);   // live TV starts on its own
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }
        s.setUserAgentString(s.getUserAgentString() + " SmartLiveTV/1.0");

        web.setBackgroundColor(0xFF07080C);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;   // keep every navigation inside the app
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // Only a failure of the page itself should drop back to setup;
                // a missing logo or a dead ad request must not.
                if (request.isForMainFrame()) {
                    showSetup(true, getString(R.string.cannot_reach));
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreenView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                fullscreenView = view;
                fullscreenCallback = callback;
                ((FrameLayout) findViewById(R.id.root)).addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                web.setVisibility(View.GONE);
                goImmersive();
            }

            @Override
            public void onHideCustomView() {
                if (fullscreenView == null) return;
                ((FrameLayout) findViewById(R.id.root)).removeView(fullscreenView);
                fullscreenView = null;
                web.setVisibility(View.VISIBLE);
                if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
                fullscreenCallback = null;
            }
        });
    }

    private void showSetup(boolean show, String message) {
        setup.setVisibility(show ? View.VISIBLE : View.GONE);
        web.setVisibility(show ? View.GONE : View.VISIBLE);
        if (message != null) {
            setupError.setText(message);
            setupError.setVisibility(View.VISIBLE);
        } else {
            setupError.setVisibility(View.GONE);
        }
        if (show) serverInput.requestFocus();
    }

    private void goImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) goImmersive();
    }

    /**
     * BACK belongs to the page: it closes the player, then the menu. Only when
     * the page says it is already at the top does the app exit.
     */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // MENU is how you get at the server address once one is already set.
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            showSetup(setup.getVisibility() != View.VISIBLE, null);
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (fullscreenView != null) {
                web.getWebChromeClient().onHideCustomView();
                return true;
            }
            if (setup.getVisibility() == View.VISIBLE) {
                finish();
                return true;
            }
            web.evaluateJavascript(
                    "(function(){try{if(window.SLTV){var root=SLTV.atRoot();SLTV.back();return root?'exit':'handled';}}catch(e){}return 'none';})()",
                    value -> {
                        if (value != null && value.contains("exit")) finish();
                        else if (value != null && value.contains("none") && web.canGoBack()) web.goBack();
                    });
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        goImmersive();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
