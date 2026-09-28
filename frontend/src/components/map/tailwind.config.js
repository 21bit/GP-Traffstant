/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
      "./src/**/*.{js,jsx,ts,tsx}",
    ],
    theme: {
      extend: {
        colors: {
          "surface": "#131313",
          "surface-container-highest": "#353534",
          "surface-variant": "#353534",
          "primary-container": "#00fbfb",
          "on-primary-container": "#007070",
          "secondary": "#b6c4ff",
          "secondary-container": "#013fb9",
          "on-secondary-container": "#a6b9ff",
          "on-surface": "#e5e2e1",
          "on-surface-variant": "#b9cac9",
          "outline": "#839493",
        },
      },
    },
    plugins: [],
  }