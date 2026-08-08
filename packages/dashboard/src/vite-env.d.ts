/// <reference types="vite/client" />

// Pulls in Vite's ambient declarations for asset imports (`*.css`, `*.svg`,
// `import.meta.env`, …). TypeScript 5.9 tolerated a side-effect import of a
// file it had no declaration for; TypeScript 6 reports TS2882 instead, which
// made `import './styles.css'` in index.tsx a type error. Vite ships these
// declarations — we just never referenced them.
