# Use an official Node.js runtime as the base image (based on Debian)
FROM node:20-slim

# Set working directory
WORKDIR /app

# Install Python, pip, and essential build tools for Python packages
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        build-essential \
        libffi-dev \
        libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip and setuptools before installing yt-dlp, using --break-system-packages
RUN pip install --upgrade pip setuptools --break-system-packages

# Install yt-dlp using pip, overriding the externally-managed-environment error
RUN pip install yt-dlp --break-system-packages

# Install ffmpeg
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copy package.json and package-lock.json to the working directory
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --production

# Copy the rest of your application code
COPY . .

# Expose the port your app runs on
EXPOSE 3000

# Command to run the application
CMD ["npm", "start"]