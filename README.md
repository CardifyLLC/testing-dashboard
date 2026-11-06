# React + Vite

## Daily regular PDF calibration (2026-11-06)

The fixed daily layout is in `scripts/order-pdf-document.mjs`, separate from
browser-local BatcherPRO settings. Regular stock uses Gap X 2.6 mm, Gap Y 6.4 mm,
top margin 15.5 mm and left margin 9.7 mm. Per-slot X offsets, left to right:

- Row 1: 0, 0, 0, 0, 0, 0 mm.
- Row 2: 0, -0.2, -0.1, -0.2, -0.2, -0.2 mm.
- Row 3: -0.2, -0.3, -0.4, -0.5, -0.6, -0.6 mm.

All Y offsets are zero; Professor confirmed the unlabeled zeros. Offsets repeat
by sheet position, including partial sheets, promos, and new PDF parts. Backs
retain vertical reflection and 180-degree artwork rotation; cut lines follow
the adjusted positions. Other print settings and registration marks are unchanged.
Foil keeps its separate 9 x 12 inch, 3 x 3 layout, 2.45 mm gap and no slot offsets.

Run `npm run test:order-pdfs` to verify actual PDF transforms, stock separation,
partial sheets and downloads. Actual regular edge gaps are 2.6 mm across row 1,
2.4/2.7/2.5/2.6/2.6 mm across row 2, and 2.5/2.5/2.5/2.5/2.6 mm across row 3.
Before production rollout, approve a physical duplex proof at 100% / Actual size.
Completed customer PDFs stay unchanged; reprints require an approved order list.


This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
