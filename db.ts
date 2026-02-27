@import "tailwindcss";

@theme {
  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-display: "Playfair Display", serif;
  --color-primary: #0ea5e9;
  --color-secondary: #10b981;
}

@layer base {
  body {
    @apply font-sans bg-slate-50 text-slate-900;
  }
}

.glass {
  @apply bg-white/70 backdrop-blur-md border border-white/20 shadow-xl;
}

.gradient-text {
  @apply bg-clip-text text-transparent bg-gradient-to-r from-sky-600 to-emerald-600;
}
