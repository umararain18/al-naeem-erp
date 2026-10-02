import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { getCurrentUser } from "@/lib/auth";
import AppSidebar from "@/components/layout/AppSidebar";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { themeInitScript } from "@/components/theme/theme-script";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ANC ERP",
  description: "Al Naeem Car Carriers Service ERP",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const user = await getCurrentUser();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Runs synchronously before paint, so Dark Mode (when
            previously chosen) is already applied before any content
            renders - avoids a flash of the wrong theme. See
            components/theme/theme-script.ts; suppressHydrationWarning
            above is scoped to this exact, expected client/server
            class-attribute difference, nothing else. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full flex flex-col lg:flex-row">
        <ThemeProvider>
          <AppSidebar user={user ? { username: user.username, role: user.role } : null} />
          <main className="flex-1 overflow-auto">
            {children}
          </main>
        </ThemeProvider>
      </body>
    </html>
  );
}
