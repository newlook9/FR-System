package com.frsystem.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

public class MainActivity extends Activity {
    private WebView web;
    private ValueCallback<Uri[]> chooser;
    private static final int PICK = 7;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE); // no screenshots
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        web.addJavascriptInterface(new Object() {
            @JavascriptInterface public void changeServer() { runOnUiThread(() -> askServer()); }
        }, "Android");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                String base = server();
                return base == null || !r.getUrl().toString().startsWith(base); // stay inside the server
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) v.loadDataWithBaseURL(null,
                    "<meta name=viewport content='width=device-width,initial-scale=1'><body style='font-family:sans-serif;padding:24px;text-align:center'>"
                    + "<h2>Cannot reach server / سرور سے رابطہ نہیں ہو سکا</h2><p>" + server() + "</p>"
                    + "<p><button style='padding:12px 20px' onclick='Android.changeServer()'>Change server / سرور تبدیل کریں</button></p>"
                    + "<p><button style='padding:12px 20px' onclick='location.href=\"" + server() + "\"'>Retry / دوبارہ کوشش</button></p></body>", "text/html", "utf-8", null);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (chooser != null) chooser.onReceiveValue(null);
                chooser = cb;
                try { startActivityForResult(p.createIntent(), PICK); } catch (Exception e) { chooser = null; return false; }
                return true;
            }
        });
        if (server() == null) askServer(); else web.loadUrl(server());
    }

    private String server() { return getSharedPreferences("frs", MODE_PRIVATE).getString("server", null); }

    private void askServer() {
        final EditText in = new EditText(this);
        in.setHint("192.168.1.10:8000");
        in.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        in.setSingleLine(true);
        String cur = server();
        if (cur != null) in.setText(cur);
        new AlertDialog.Builder(this).setTitle("Server address / سرور کا پتہ").setView(in).setCancelable(server() != null)
            .setPositiveButton("Connect / جڑیں", (d, w) -> {
                String u = in.getText().toString().trim();
                if (u.isEmpty()) { askServer(); return; }
                if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
                while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
                getSharedPreferences("frs", MODE_PRIVATE).edit().putString("server", u).apply();
                web.loadUrl(u);
            }).show();
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        if (req == PICK && chooser != null) { chooser.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data)); chooser = null; }
        else super.onActivityResult(req, res, data);
    }

    @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}
