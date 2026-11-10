"use client";

import { usePathname } from "next/navigation";
import { CommandBar } from "./CommandBar";

/** The Company Brain command bar lives in the root layout so it — and its
 *  ⌘K / Ctrl+K shortcut — is available on every page except sign-in. */
export function GlobalCommandBar() {
  const pathname = usePathname();
  if (pathname === "/login") return null;
  return (
    <div className="command-region">
      <CommandBar />
    </div>
  );
}
