# Parteek's TV - Modern IPTV Streaming Platform

A beautiful, Netflix-style IPTV streaming platform built with Docker, Node.js, and modern web technologies. Browse and watch live TV channels from around the world with a sleek, responsive interface.

![IPTV Platform](https://img.shields.io/badge/version-1.0.0-blue)
![Docker](https://img.shields.io/badge/docker-ready-brightgreen)
![License](https://img.shields.io/badge/license-MIT-green)

## ✨ Features

### 🎬 Modern Netflix-Style Interface
- **Hero Video Player**: Cinematic full-width player with smooth transitions
- **Card-Based Grid**: Responsive channel cards with hover effects and play icons
- **Dark Theme**: Professional Netflix-inspired color scheme
- **Smooth Animations**: Scale effects, transitions, and scroll-based header changes

### 📺 Advanced Channel Management
- **Smart Search**: Real-time filtering across all channels
- **Category Browsing**: Filter by channel groups/categories
- **Channel Logos**: Display channel artwork and branding
- **Active Indicators**: Visual feedback for currently playing channel

### ⚙️ Playlist Customization
- **In-App Playlist Switcher**: Change playlists without editing config files
- **Quick Presets**: One-click access to popular IPTV sources
- **Custom URL Support**: Add any M3U/M3U8 playlist URL
- **LocalStorage Persistence**: Your playlist preference is saved automatically

### 🚀 Performance & Reliability
- **HLS.js Integration**: Advanced video streaming with adaptive bitrate
- **Error Recovery**: Automatic retry logic for failed streams
- **Timeout Handling**: 15-second timeouts to prevent hanging
- **DNS Optimization**: Multiple DNS servers for better resolution
- **Connection Pooling**: Keep-alive connections for improved performance

### 🐳 Easy Deployment
- **Docker Compose**: One-command setup
- **xTeVe Integration**: Optional IPTV proxy and DVR functionality
- **Volume Persistence**: Configuration saved across container restarts

## 📋 Prerequisites

- Docker & Docker Compose
- Ports `8080` (web app) and `34400` (xTeVe) available

## 🚀 Quick Start

1. **Clone the repository**:
   ```bash
   git clone git@github.com:bindrap/IPTV.git
   cd IPTV
   ```

2. **Start the application**:
   ```bash
   docker compose up -d --build
   ```

3. **Access the web interface**:
   - Open http://localhost:8080
   - Browse channels and start watching!

4. **(Optional) Configure xTeVe**:
   - Open http://localhost:34400
   - Follow the setup wizard to add custom playlists
   - Enable filtering, mapping, and DVR features

## 🎯 Usage

### Changing Playlists

1. Click **"⚙ Playlist Settings"** in the header
2. Choose from quick presets:
   - **IPTV-org** (Recommended) - Reliable community playlist
   - **Free-TV** - Alternative community source
   - **xTeVe** - Your local xTeVe server
3. Or paste your own M3U/M3U8 URL
4. Click **"Apply & Reload"**

Your selection is saved and will load automatically next time!

### Browsing Channels

- **Search**: Type in the search box to filter by channel name
- **Filter by Category**: Use the dropdown to show specific channel groups
- **Play**: Click any channel card to start streaming

## 🏗️ Architecture

```
├── backend/                 # Node.js Express API
│   ├── src/
│   │   └── index.js        # API server with playlist parsing and stream proxy
│   ├── package.json
│   └── Dockerfile
├── public/                  # Frontend static files
│   └── index.html          # Single-page application
├── data/                    # xTeVe persistent data (gitignored)
├── docker-compose.yml       # Docker services configuration
└── README.md
```

## 🛠️ Configuration

### Environment Variables

Edit `docker-compose.yml` to customize:

```yaml
environment:
  # Default playlist URL (can be changed in-app)
  - PLAYLIST_URL=https://iptv-org.github.io/iptv/index.m3u

  # Allow self-signed certificates for streams
  - ALLOW_INSECURE=true
```

### DNS Configuration

The app uses multiple DNS servers for better reliability:
- Google DNS: 8.8.8.8, 8.8.4.4
- Cloudflare DNS: 1.1.1.1, 1.0.0.1

## 🧪 Development

Run the backend locally without Docker:

```bash
cd backend
npm install
PLAYLIST_URL=https://iptv-org.github.io/iptv/index.m3u npm start
```

Then open http://localhost:8080

## 🐛 Troubleshooting

### Channels not loading
- Check your internet connection
- Try a different playlist in Settings
- Verify the playlist URL is valid M3U/M3U8 format

### DNS Resolution Errors
- The app uses Google/Cloudflare DNS by default
- Some streams may be geo-blocked or unavailable

### Playback Issues
- Ensure your browser supports HLS (most modern browsers do)
- Check browser console for detailed error messages
- Try a different channel - some streams may be offline

## 📦 Technology Stack

- **Backend**: Node.js, Express
- **Frontend**: Vanilla JavaScript, HLS.js
- **Containerization**: Docker, Docker Compose
- **IPTV Proxy**: xTeVe (optional)

## 🤝 Contributing

Contributions are welcome! Feel free to:
- Report bugs
- Suggest features
- Submit pull requests

## 📄 License

MIT License - feel free to use this project for personal or commercial purposes.

## 🙏 Acknowledgments

- [IPTV-org](https://github.com/iptv-org/iptv) - Comprehensive community IPTV collection
- [xTeVe](https://github.com/xteve-project/xTeVe) - IPTV proxy and EPG aggregator
- [HLS.js](https://github.com/video-dev/hls.js/) - JavaScript HLS client

---

**Made with ❤️ by Parteek**
