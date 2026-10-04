import { Geist, Geist_Mono } from "next/font/google"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import "./globals.css"

const sans = Geist({ subsets: ["latin"], variable: "--font-sans" })
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" })

export const metadata = {
  title: "fx-durable code",
  description: "A durable coding agent: AI SDK HarnessAgent + fx-durable, running locally."
}

// Follow the OS color scheme before first paint.
const themeScript = `try{if(matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.classList.add('dark')}catch(e){}`

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn("font-sans antialiased", sans.variable, mono.variable)} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
