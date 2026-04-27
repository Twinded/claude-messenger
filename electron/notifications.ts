/**
 * Native OS notifications + system tray.
 *
 * Surfaces three classes of events to the user when no Claude Messenger
 * window has focus:
 *   - assistant message completed
 *   - permission request from the SDK
 *   - app update available
 *
 * Notifications are silent if a window is currently focused, since the
 * in-app sound effects already cover that case. The system tray icon
 * carries the unread count as a tooltip + macOS dock badge.
 */

import { app, BrowserWindow, nativeImage, Notification, Tray, Menu } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface NotificationsService {
  notifyAssistantMessage(opts: { contactName: string; preview: string }): void;
  notifyPermissionRequest(opts: { contactName: string; toolName: string }): void;
  notifyUpdateAvailable(opts: { latestVersion: string }): void;
  setUnreadCount(count: number): void;
  destroy(): void;
}

interface CreateNotificationsServiceOptions {
  windows: Map<string, BrowserWindow>;
  isDev: boolean;
  onTrayQuit?: () => void;
  onTrayShow?: () => void;
  logDebug: (event: string, details?: Record<string, unknown>) => void;
}

function trayIconPath(isDev: boolean): string {
  // Use a small 16x16 PNG for the tray. We reuse the main app icon since
  // we don't yet ship a dedicated tray asset; macOS auto-templates white-
  // on-black mask icons.
  return isDev
    ? path.join(__dirname, "..", "..", "public", "icons", "claude-messenger.png")
    : path.join(process.resourcesPath, "public", "icons", "claude-messenger.png");
}

export function createNotificationsService(
  options: CreateNotificationsServiceOptions
): NotificationsService {
  const { windows, isDev, onTrayQuit, onTrayShow, logDebug } = options;
  let tray: Tray | null = null;
  let unreadCount = 0;

  function anyWindowFocused(): boolean {
    for (const win of windows.values()) {
      if (!win.isDestroyed() && win.isFocused()) return true;
    }
    return false;
  }

  function safeShow(notification: Notification): void {
    try {
      notification.show();
    } catch (error) {
      logDebug("notifications.show.error", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  function focusFirstWindow(): void {
    const main = windows.get("main");
    if (main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
      return;
    }
    for (const win of windows.values()) {
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
        return;
      }
    }
    onTrayShow?.();
  }

  function buildTrayMenu(): Menu {
    return Menu.buildFromTemplate([
      { label: `Non lus : ${unreadCount}`, enabled: false },
      { type: "separator" },
      { label: "Ouvrir Claude Messenger", click: focusFirstWindow },
      { type: "separator" },
      {
        label: "Quitter",
        click: () => {
          onTrayQuit?.();
          app.quit();
        }
      }
    ]);
  }

  function ensureTray(): void {
    if (tray) return;
    try {
      const image = nativeImage.createFromPath(trayIconPath(isDev));
      const resized = image.isEmpty() ? image : image.resize({ width: 16, height: 16 });
      tray = new Tray(resized);
      tray.setToolTip("Claude Messenger");
      tray.setContextMenu(buildTrayMenu());
      tray.on("click", focusFirstWindow);
    } catch (error) {
      logDebug("notifications.tray.error", {
        message: error instanceof Error ? error.message : String(error)
      });
      tray = null;
    }
  }

  ensureTray();

  return {
    notifyAssistantMessage({ contactName, preview }) {
      if (!Notification.isSupported()) return;
      if (anyWindowFocused()) return;
      const notification = new Notification({
        title: contactName,
        body: preview.slice(0, 240),
        silent: true
      });
      notification.on("click", focusFirstWindow);
      safeShow(notification);
    },

    notifyPermissionRequest({ contactName, toolName }) {
      if (!Notification.isSupported()) return;
      const notification = new Notification({
        title: `${contactName} demande une autorisation`,
        body: `Outil : ${toolName}. Clique pour répondre.`,
        urgency: "critical"
      });
      notification.on("click", focusFirstWindow);
      safeShow(notification);
    },

    notifyUpdateAvailable({ latestVersion }) {
      if (!Notification.isSupported()) return;
      const notification = new Notification({
        title: "Mise à jour disponible",
        body: `Claude Messenger ${latestVersion} est disponible.`,
        silent: true
      });
      notification.on("click", focusFirstWindow);
      safeShow(notification);
    },

    setUnreadCount(count) {
      unreadCount = Math.max(0, count);
      if (process.platform === "darwin") {
        app.dock?.setBadge?.(unreadCount > 0 ? String(unreadCount) : "");
      }
      tray?.setContextMenu(buildTrayMenu());
      tray?.setToolTip(unreadCount > 0
        ? `Claude Messenger — ${unreadCount} non lu(s)`
        : "Claude Messenger");
    },

    destroy() {
      tray?.destroy();
      tray = null;
    }
  };
}
