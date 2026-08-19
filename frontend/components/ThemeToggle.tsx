"use client";

import { useEffect, useState } from "react";

type Mode = "system" | "light" | "dark";
const NEXT: Record<Mode, Mode> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<Mode, string> = { system: "Theo hệ thống", light: "Sáng", dark: "Tối" };

export default function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("system");

  useEffect(() => {
    const saved = localStorage.getItem("loglens-theme") as Mode | null;
    if (saved) setMode(saved);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
    localStorage.setItem("loglens-theme", mode);
  }, [mode]);

  return (
    <button className="ghost" onClick={() => setMode(NEXT[mode])} title="Đổi theme">
      Theme: {LABEL[mode]}
    </button>
  );
}
