# wireless_network (Smart Media Switch)

AI-powered adaptive media streaming web application that dynamically switches between video and audio playback modes based on real-time wireless network bandwidth conditions.

## 🌟 Key Features

- **Real-Time Network Speed Monitoring**: Live bandwidth throughput & latency measurement.
- **Intelligent LLM/Rule-Based Media Switching**: Dynamically evaluates network thresholds to switch between YouTube Video (1080p FHD, 720p HD, 480p SD) and Audio (192 Kbps) to eliminate buffer stalls.
- **Embedded Media Player**: Seamless playback for music and videos.
- **Express + Vite Fullstack Architecture**: Lightweight backend API proxy with high-performance React frontend.

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+ recommended)
- `npm`

### Installation

```bash
# Clone the repository
git clone https://github.com/Naveenraj-Ece/wireless_network.git

# Navigate to the project directory
cd wireless_network

# Install dependencies
npm install
```

### Running Locally

1. **Start the Backend Server (Port 3001)**:
   ```bash
   node server/index.js
   ```

2. **Start the Vite Frontend (Port 5173)**:
   ```bash
   npm run dev
   ```

3. Open your browser and navigate to:
   ```
   http://localhost:5173
   ```

---

## 📁 Project Structure

```
├── api/            # Serverless / API handlers
├── public/         # Static assets
├── server/         # Express backend server (speedtest, streaming recommendations)
│   ├── data/       # Dataset CSVs for network thresholds
│   └── index.js    # Express entrypoint
├── src/            # React frontend source files
├── index.html      # HTML template
├── package.json    # Project dependencies and scripts
├── vercel.json     # Deployment configuration
└── vite.config.js  # Vite configuration & API proxy setup
```

---

## 🛠️ Tech Stack

- **Frontend**: React, Vite, Vanilla CSS
- **Backend**: Node.js, Express, CORS
- **APIs & Tools**: YouTube Search API, Distube YTDL, PapaParse
