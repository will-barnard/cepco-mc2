FROM node:20-alpine

WORKDIR /app

# Dependencies first so a source-only change doesn't reinstall node_modules.
COPY backend/package.json ./backend/package.json
RUN cd backend && npm install --omit=dev

# The backend also needs database/migrations (schema) and assets/ (the one-time
# CSV import), which is why the build context is the repo root.
COPY backend ./backend
COPY database ./database
COPY assets ./assets

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

CMD ["node", "backend/src/index.js"]
