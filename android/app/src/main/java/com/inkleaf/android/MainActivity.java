package com.inkleaf.android;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.database.Cursor;
import android.app.AlertDialog;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import androidx.core.view.WindowCompat;
import androidx.core.graphics.Insets;
import androidx.webkit.WebViewFeature;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.content.Context;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebSettings;
import android.widget.FrameLayout;
import androidx.annotation.Nullable;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharsetDecoder;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String START = ORIGIN + "/assets/www/index.html";
    private static final int OPEN = 41, EXPORT = 42, MAX_BYTES = 2 * 1024 * 1024;
    private WebView webView;
    private View rootView;
    private ExecutorService io;
    private String pendingId;

    @Override public void onCreate(@Nullable Bundle state) {
        super.onCreate(state);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        io = Executors.newSingleThreadExecutor();
        FrameLayout root = new FrameLayout(this);
        rootView = root;
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            int keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
            root.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard));
            // The root owns these insets. Do not let WebView apply the same
            // system-bar / IME space again via its viewport safe-area values.
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(root);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            android.widget.TextView notice = new android.widget.TextView(this);
            notice.setText("请更新 Android System WebView 后重新打开墨页。");
            notice.setPadding(32, 64, 32, 32);
            root.removeAllViews(); root.addView(notice);
            return;
        }
        configureWebView();
        webView.loadUrl(START);
    }

    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // 网页草稿使用 localStorage，不是文件存储权限。
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false);
        s.setBlockNetworkLoads(true);
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                if (!isTrusted(Uri.parse(url))) { result.cancel(); return true; }
                new AlertDialog.Builder(MainActivity.this).setTitle("墨页")
                    .setMessage(message).setPositiveButton("继续", (dialog, which) -> result.confirm())
                    .setNegativeButton("取消", (dialog, which) -> result.cancel())
                    .setOnCancelListener(dialog -> result.cancel()).show();
                return true;
            }
        });
        WebView.setWebContentsDebuggingEnabled(false);
        WebViewCompat.addWebMessageListener(webView, "InkLeafAndroid",
                java.util.Collections.singleton(ORIGIN), (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                    if (!isMainFrame || sourceOrigin == null || !ORIGIN.equals(sourceOrigin.toString())) return;
                    handleMessage(message.getData());
                });
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        webView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return loader.shouldInterceptRequest(r.getUrl());
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, String url) {
                return loader.shouldInterceptRequest(Uri.parse(url));
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return !isTrusted(r.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, String url) {
                return !isTrusted(Uri.parse(url));
            }
            @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) {
                if (!isTrusted(Uri.parse(url))) v.stopLoading();
            }
        });
    }

    private boolean isTrusted(Uri u) {
        return u != null && ORIGIN.equals(u.getScheme() + "://" + u.getAuthority())
                && "/assets/www/index.html".equals(u.getPath());
    }
    private boolean bridgeAllowed() { return webView != null && isTrusted(Uri.parse(webView.getUrl())); }

    private void handleMessage(String raw) {
        if (!bridgeAllowed() || raw == null || raw.length() > 14 * 1024 * 1024) return;
        try {
            JSONObject m = new JSONObject(raw); String id = m.optString("id", "");
            String action = m.optString("action", "");
            if (id.isEmpty() || (!"open".equals(action) && !"export".equals(action))) return;
            runOnUiThread(() -> begin(id, action, m));
        } catch (Exception ignored) { }
    }
    private void begin(String id, String action, JSONObject message) {
        if (pendingId != null) { reply(id, error("busy")); return; }
        pendingId = id;
        if ("export".equals(action)) {
            synchronized (exports) { exports.put(id, message.optString("text", "")); }
        }
        Intent i = new Intent("open".equals(action) ? Intent.ACTION_OPEN_DOCUMENT : Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        if ("open".equals(action)) {
            i.setType("*/*");
            i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"text/*", "application/octet-stream"});
        } else i.setType("text/markdown");
        if ("export".equals(action)) i.putExtra(Intent.EXTRA_TITLE, safeName(message.optString("filename", "未命名.md")));
        try { startActivityForResult(i, "open".equals(action) ? OPEN : EXPORT); }
        catch (Exception failure) {
            pendingId = null;
            synchronized (exports) { exports.remove(id); }
            reply(id, error("无法打开系统文件选择器，请重试"));
        }
    }
    private String safeName(String n) { if (n == null || n.isEmpty()) return "未命名.md"; return n.replaceAll("[\\x00-\\x1f\\\\/:*?\"<>|]", "_"); }
    private JSONObject error(String text) { JSONObject o = new JSONObject(); try { o.put("error", text); } catch (Exception ignored) {} return o; }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != OPEN && request != EXPORT) return;
        final String id = pendingId; pendingId = null;
        if (id == null) return;
        if (result != RESULT_OK || data == null || data.getData() == null) { synchronized (exports) { exports.remove(id); } JSONObject o = new JSONObject(); try { o.put("canceled", true); } catch (Exception ignored) {} reply(id, o); return; }
        Uri uri = data.getData();
        io.execute(() -> { try {
            if (request == OPEN) {
                String name = displayName(uri);
                if (!name.toLowerCase(java.util.Locale.ROOT).matches(".*\\.(md|markdown|txt)$")) throw new Exception("请选择 .md、.markdown 或 .txt 文件");
                byte[] bytes = readLimited(uri); String text = decodeAndNormalize(bytes);
                JSONObject o = new JSONObject(); o.put("filename", displayName(uri)); o.put("text", text); reply(id, o);
            } else {
                String text = exportTextById(id); byte[] out = text.getBytes(StandardCharsets.UTF_8); if (out.length > MAX_BYTES) throw new Exception("文件超过 2 MB 限制");
                try (OutputStream stream = getContentResolver().openOutputStream(uri, "w")) { if (stream == null) throw new Exception("无法写入"); stream.write(out); stream.flush(); }
                JSONObject o = new JSONObject(); o.put("filename", displayName(uri)); reply(id, o);
            }
        } catch (Exception e) { reply(id, error(e.getMessage() == null ? "文件操作失败" : e.getMessage())); } });
    }
    private final java.util.Map<String,String> exports = new java.util.HashMap<>();
    private String exportTextById(String id) { synchronized (exports) { String s = exports.remove(id); return s == null ? "" : s; } }
    private byte[] readLimited(Uri uri) throws Exception { try (InputStream in = getContentResolver().openInputStream(uri)) { if (in == null) throw new Exception("无法读取"); ByteArrayOutputStream b = new ByteArrayOutputStream(); byte[] x = new byte[8192]; int n, total=0; while ((n=in.read(x)) != -1) { total += n; if (total > MAX_BYTES) throw new Exception("文件超过 2 MB 限制"); b.write(x,0,n); } return b.toByteArray(); } }
    private String decodeAndNormalize(byte[] b) throws CharacterCodingException { int off=(b.length>=3&& (b[0]&255)==0xEF&&(b[1]&255)==0xBB&&(b[2]&255)==0xBF)?3:0; CharsetDecoder d=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT); return d.decode(ByteBuffer.wrap(b,off,b.length-off)).toString().replace("\r\n", "\n").replace('\r','\n'); }
    private String displayName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (name != null && !name.isEmpty()) return safeName(name);
            }
        } catch (Exception ignored) { }
        return "未命名.md";
    }
    private void reply(String id, JSONObject result) { runOnUiThread(() -> { if (!bridgeAllowed()) return; try { result.put("id",id); String js="window.dispatchEvent(new CustomEvent('inkleaf-native-result',{detail:"+result+"}));"; webView.evaluateJavascript(js,null); } catch (Exception ignored) {} }); }
    @Override public void onBackPressed() {
        if (webView == null || !bridgeAllowed()) { super.onBackPressed(); return; }
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(rootView);
        if (insets != null && insets.isVisible(WindowInsetsCompat.Type.ime())) {
            InputMethodManager imm = (InputMethodManager)getSystemService(Context.INPUT_METHOD_SERVICE);
            imm.hideSoftInputFromWindow(webView.getWindowToken(), 0);
            webView.clearFocus();
            return;
        }
        webView.evaluateJavascript("(() => {const e = new Event('inkleaf-back', {cancelable:true}); window.dispatchEvent(e); window.dispatchEvent(new Event('pagehide')); return e.defaultPrevented;})()",
            handled -> { if (!"true".equals(handled) && !isFinishing()) finish(); });
    }
    @Override protected void onPause() {
        if (webView != null && bridgeAllowed()) webView.evaluateJavascript("window.dispatchEvent(new Event('pagehide'));", null);
        super.onPause();
    }
    @Override protected void onDestroy() { if (io != null) io.shutdownNow(); synchronized (exports) { exports.clear(); } pendingId = null; if (webView != null) webView.destroy(); super.onDestroy(); }
}
