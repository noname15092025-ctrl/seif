package app.shut.wallet;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

/**
 * Виджет SHUT на главном экране: три кнопки — Задачи, Календарь, Заметки.
 * Виджет не читает данные сейфа (они зашифрованы): он только открывает приложение
 * ссылкой shut://… на нужном разделе. Если сейф заблокирован, раздел откроется после входа.
 */
public class ShutWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.shut_widget);
            v.setOnClickPendingIntent(R.id.w_tasks, open(ctx, "tasks", 1));
            v.setOnClickPendingIntent(R.id.w_calendar, open(ctx, "calendar", 2));
            v.setOnClickPendingIntent(R.id.w_notes, open(ctx, "notes", 3));
            mgr.updateAppWidget(id, v);
        }
    }

    private static PendingIntent open(Context ctx, String view, int code) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("shut://" + view));
        i.setPackage(ctx.getPackageName());
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
