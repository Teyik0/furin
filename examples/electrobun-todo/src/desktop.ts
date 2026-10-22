import { getDesktopHost } from "@teyik0/furin-electrobun/host";
import { ApplicationMenu, Tray } from "electrobun/main";

const items = [
  { type: "normal" as const, label: "Open Relay", action: "open-main", tooltip: "Show your tasks" },
  { type: "normal" as const, label: "Open in browser", action: "open-browser" },
  { type: "divider" as const },
  { type: "normal" as const, label: "Quit Relay", action: "quit", accelerator: "CmdOrCtrl+Q" },
];

// SDK events run outside HTTP. Catch both synchronous and asynchronous failures.
function action(name: string) {
  Promise.resolve()
    .then(() => {
      const desktop = getDesktopHost();
      switch (name) {
        case "open-main":
          desktop?.open();
          break;
        case "open-browser":
          desktop?.browser.open("/");
          break;
        case "quit":
          return desktop?.quit();
        default:
          break;
      }
    })
    .catch(() => console.error("Relay native action failed."));
}

ApplicationMenu.setApplicationMenu([
  { label: "Relay", submenu: items },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  },
]);
function dispatch(event: unknown) {
  if (
    typeof event === "object" &&
    event !== null &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "action" in event.data &&
    typeof event.data.action === "string"
  ) {
    action(event.data.action);
  }
}
ApplicationMenu.on("application-menu-clicked", dispatch);

const tray = new Tray({ title: "Relay", width: 18, height: 18 });
tray.setMenu(items);
tray.on("tray-clicked", dispatch);
