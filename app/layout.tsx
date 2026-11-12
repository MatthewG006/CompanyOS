import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AdminTokenProvider } from "@/components/AdminToken";
import { GlobalCommandBar } from "@/components/GlobalCommandBar";
import { Sidebar } from "@/components/Sidebar";
import { VoiceAssistant } from "@/components/VoiceAssistant";

export const metadata: Metadata = {
  title: "Sky Mountain CompanyOS",
  description: "AI-native business command center",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
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
            <VoiceAssistant />
          </div>
        </AdminTokenProvider>
      </body>
    </html>
  );
}
