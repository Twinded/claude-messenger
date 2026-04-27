/**
 * BrowserWindow factory. Centralizes security defaults (sandbox, contextIsolation,
 * no nodeIntegration), window chrome handling (frameless XP-style window),
 * external URL handling, and structured logging of window lifecycle events.
 */

import { BrowserWindow, shell, type BrowserWindowConstructorOptions } from "electron";
import path from "node:path";

import { isSafeExternalUrl } from "./security.js";

interface ManagedWindow extends BrowserWindow {
  claudeMessengerTitle?: string;
}

export type WindowKey = string;

export interface CreateBaseWindowFactoryOptions {
  preloadPath: string;
  appIconPath?: string;
  windows: Map<WindowKey, ManagedWindow>;
  showDockIcon: () => void;
  smokeTest?: boolean;
  onSmokeReady?: () => void;
  logDebug?: (event: string, details?: Record<string, unknown>) => void;
}

export interface BaseWindowOptions extends BrowserWindowConstructorOptions {
  title?: string;
}

export function setStableWindowTitle(win: ManagedWindow, title: string): void {
  if (!win || win.isDestroyed()) return;
  win.claudeMessengerTitle = title;
  win.setTitle(title);
}

export function createBaseWindowFactory(options: CreateBaseWindowFactoryOptions) {
  const {
    preloadPath,
    appIconPath,
    windows,
    showDockIcon,
    smokeTest = false,
    onSmokeReady,
    logDebug = () => {}
  } = options;

  return function createBaseWindow(key: WindowKey, opts: BaseWindowOptions): ManagedWindow {
    const initialTitle = opts.title ?? "Claude Messenger";
    const win = new BrowserWindow({
      frame: false,
      show: false,
      resizable: true,
      backgroundColor: "#edf6ff",
      titleBarStyle: "hidden",
      icon: appIconPath,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      },
      ...opts
    }) as ManagedWindow;

    win.claudeMessengerTitle = initialTitle;
    windows.set(key, win);

    const logWindowEvent = (event: string, details: Record<string, unknown> = {}): void => {
      try {
        const webContentsDestroyed = win.webContents?.isDestroyed?.() ?? true;
        logDebug(`window.${event}`, {
          key,
          title: win.claudeMessengerTitle ?? initialTitle,
          url: win.isDestroyed() || webContentsDestroyed ? "" : win.webContents.getURL() || "",
          ...details
        });
      } catch (error) {
        logDebug(`window.${event}`, {
          key,
          title: initialTitle,
          url: "",
          logError: error instanceof Error ? error.message : String(error)
        });
      }
    };

    win.setMenuBarVisibility(false);

    win.on("page-title-updated", (event) => {
      if (!win.claudeMessengerTitle) return;
      event.preventDefault();
      win.setTitle(win.claudeMessengerTitle);
    });

    win.once("ready-to-show", () => {
      logWindowEvent("ready-to-show");
      showDockIcon();
      win.show();
      if (smokeTest) setTimeout(() => onSmokeReady?.(), 500);
    });

    win.webContents.on("render-process-gone", (_event, details) => {
      logWindowEvent("render-process-gone", { ...details });
    });
    win.webContents.on("unresponsive", () => logWindowEvent("unresponsive"));
    win.webContents.on("responsive", () => logWindowEvent("responsive"));
    win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      logWindowEvent("did-fail-load", { errorCode, errorDescription, validatedURL, isMainFrame });
    });
    win.webContents.on("preload-error", (_event, preloadFile, error) => {
      logWindowEvent("preload-error", {
        preloadFile,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack ?? "" : ""
      });
    });

    win.on("closed", () => {
      logWindowEvent("closed");
      windows.delete(key);
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) {
        void shell.openExternal(url);
      } else {
        shell.beep();
      }
      return { action: "deny" };
    });

    return win;
  };
}

