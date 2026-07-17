/**
 * Overview & Purpose
 * Enables Tailwind processing for the application stylesheet.
 *
 * Architectural Relationships
 * Called by: The Vite/PostCSS build pipeline.
 * Calls: @tailwindcss/postcss.
 *
 * External Resources
 * app/globals.css.
 *
 * Notes
 * This file contains build configuration only.
 */


const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
