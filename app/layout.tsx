import type { Metadata } from "next";
import "./globals.css";
import { AdminTokenProvider } from "@/components/AdminToken";
import { GlobalCommandBar } from "@/components/GlobalCommandBar";
import { Sidebar } from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "Sky Mountain CompanyOS",
  description: "AI-native business command center",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <AdminTokenProvider>
          <div className="app-shell">
            <Sidebar ownerAuthEnabled={process.env.NODE_ENV === "production"} />
            <main className="main-area">
              <GlobalCommandBar />
              {children}
            </main>
          </div>
        </AdminTokenProvider>
      </body>
    </html>
  );
}
