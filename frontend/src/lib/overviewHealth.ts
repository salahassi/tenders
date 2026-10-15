import { useEffect, useState } from "react";

const storageKey = "tenderdesk:overview-processing-health";
export const overviewHealthEvent = "tenderdesk:overview-health";

let memory: "shown" | "hidden" = "shown";

export function overviewHealthVisible() {
  try {
    const stored = localStorage.getItem(storageKey);
    memory = stored === "hidden" ? "hidden" : "shown";
    return stored !== "hidden";
  } catch {
    return memory !== "hidden";
  }
}

export function setOverviewHealthVisible(visible: boolean) {
  memory = visible ? "shown" : "hidden";
  try {
    if (visible) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, "hidden");
  } catch {
    // Private browsing can block storage. The choice still applies in this tab.
  }
  window.dispatchEvent(new Event(overviewHealthEvent));
}

export function useOverviewHealthVisible() {
  const [visible, setVisible] = useState(overviewHealthVisible);
  useEffect(() => {
    const sync = () => setVisible(overviewHealthVisible());
    window.addEventListener(overviewHealthEvent, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(overviewHealthEvent, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return visible;
}
