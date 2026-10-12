package com.pokemon.idle;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * 后台常驻：一个前台服务，让系统把进程提到前台优先级（小米/红米/ColorOS 这类不随便清后台）。
 * 通知只做"服务在运行"的标记，网页层不传文案就取下面的默认值（切后台 JS 会被冻结，
 * 推过去的捕捉/地区状态只会是停摆前的旧值）；再次 start 即刷新，不会重新响铃（setOnlyAlertOnce）。
 * 类型用 dataSync，必须和清单里的 foregroundServiceType 一致，否则 Android 14+ 会抛
 * MissingForegroundServiceTypeException。
 */
public class KeepAliveService extends Service {
    private static final String CHANNEL_ID = "pokeidle_keepalive";
    private static final int NOTIFICATION_ID = 1;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null ? intent.getStringExtra("title") : null;
        String text = intent != null ? intent.getStringExtra("text") : null;
        if (title == null || title.isEmpty()) title = "口袋挂机运行中";
        if (text == null || text.isEmpty()) text = "点击回到游戏";

        createChannel();
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false);
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        builder.setContentIntent(open);
        Notification notification = builder.build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        return START_STICKY;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "后台挂机", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("保持游戏在后台运行");
        channel.setShowBadge(false);
        nm.createNotificationChannel(channel);
    }
}
