package com.pokemon.idle;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 插件必须在 super.onCreate 之前注册，否则 JS 侧找不到它（bridge 在 super 里初始化）
        registerPlugin(KeepAlivePlugin.class);
        super.onCreate(savedInstanceState);
        // WebView 默认要求先有用户手势才允许播放音频：关掉它，切后台回来也能接着放 BGM
        getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        // 文本缩放钉死 100%：部分手机把系统字号调大后 WebView 会跟着放大文字，像素布局会被撑坏
        getBridge().getWebView().getSettings().setTextZoom(100);
        // 允许电脑上用 chrome://inspect 调试（开发期开着方便，正式发布想关掉就删这行）
        WebView.setWebContentsDebuggingEnabled(true);
    }
}
