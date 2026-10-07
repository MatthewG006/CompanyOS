import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "Sky Mountain CompanyOS",
  description: "AI-native business command center",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <Sidebar ownerAuthEnabled={process.env.NODE_ENV === "production"} />
          <main className="main-area">{children}</main>
        </div>
      </body>
    </html>
  );
}
