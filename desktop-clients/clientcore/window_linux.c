//go:build linux && cgo

#include <gtk/gtk.h>
#include <webkit2/webkit2.h>

static gboolean rtx5_quit_cb(gpointer data) {
    (void)data;
    gtk_main_quit();
    return G_SOURCE_REMOVE;
}

static void rtx5_destroy_cb(GtkWidget *widget, gpointer data) {
    (void)widget;
    (void)data;
    gtk_main_quit();
}

void rtx5_run_linux_webview(const char* urlStr, const char* titleStr) {
    gtk_init(0, NULL);

    GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(window), titleStr ? titleStr : "RTX5 Desktop");
    gtk_window_set_default_size(GTK_WINDOW(window), 1400, 900);
    gtk_window_maximize(GTK_WINDOW(window));
    g_signal_connect(window, "destroy", G_CALLBACK(rtx5_destroy_cb), NULL);

    GtkWidget *webView = webkit_web_view_new();
    gtk_container_add(GTK_CONTAINER(window), webView);

    webkit_web_view_load_uri(WEBKIT_WEB_VIEW(webView), urlStr ? urlStr : "about:blank");

    gtk_widget_show_all(window);
    gtk_main();
}

void rtx5_quit_linux_webview(void) {
    g_idle_add(rtx5_quit_cb, NULL);
}
