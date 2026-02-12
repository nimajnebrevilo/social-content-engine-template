FROM node:22-alpine

WORKDIR /app

# Install ALL dependencies (tsx needed at runtime)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Copy voice profile (if present)
COPY voice-profile.md* ./

# Run with tsx (transpiles TypeScript on the fly)
CMD ["npx", "tsx", "src/index.ts"]
