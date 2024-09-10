# Use Node.js v14 as the base image
FROM node:14

# Create and set the working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm install

# Install FFmpeg and required dependencies
RUN apt-get update && \
    apt-get install -y ffmpeg \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install ffprobe-static and ffmpeg-static to ensure availability
RUN npm install ffprobe-static@latest ffmpeg-static@latest

# Copy the rest of the application code
COPY . .

# Expose port 8080
EXPOSE 8080

# Command to run the application
CMD [ "node", "server.js" ]
