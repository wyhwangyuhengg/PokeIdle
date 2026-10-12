package com.pokemon.idle;

import android.Manifest;
import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 网页层的桥：开启/关闭后台常驻的前台服务。通知文案由服务自己取默认值，网页层不传状态。
 */
@CapacitorPlugin(
        name = "KeepAlive",
        permissions = @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
)
public class KeepAlivePlugin extends Plugin {
    private PluginCall pending;
    private String pendingTitle = "";
    private String pendingText = "";

    @PluginMethod
    public void start(PluginCall call) {
        pendingTitle = call.getString("title", "");
        pendingText = call.getString("text", "");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState("notifications") != PermissionState.GRANTED) {
            pending = call;
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        doStart(pendingTitle, pendingText);
        call.resolve(new JSObject());
    }

    // 权限给不给都照起服务：没有通知权限也能保活，只是通知看不见
    @PermissionCallback
    private void afterPermission(PluginCall call) {
        doStart(pendingTitle, pendingText);
        (pending != null ? pending : call).resolve(new JSObject());
        pending = null;
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), KeepAliveService.class));
        call.resolve(new JSObject());
    }

    private void doStart(String title, String text) {
        Intent intent = new Intent(getContext(), KeepAliveService.class);
        intent.putExtra("title", title);
        intent.putExtra("text", text);
        getContext().startForegroundService(intent);
    }
}
