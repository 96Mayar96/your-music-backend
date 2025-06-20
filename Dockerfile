# Use an official Node.js runtime as the base image (based on Debian)
FROM node:20-slim

# Set working directory
WORKDIR /app

# Install Python, pip, and essential build tools for Python packages
# This helps resolve common 'pip install' errors
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        build-essential \
        # Required for many Python packages, including some native extensions yt-dlp might use
        libffi-dev \
        libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp using pip
# yt-dlp is a popular fork of youtube-dl and is actively maintained.
RUN pip install yt-dlp

# Install ffmpeg
# ffmpeg is required for audio conversion (e.g., to MP3)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copy package.json and package-lock.json to the working directory
# This is done separately to leverage Docker's layer caching for faster builds
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --production

# Copy the rest of your application code
COPY . .

# Expose the port your app runs on
EXPOSE 3000

# Command to run the application
CMD ["npm", "start"]