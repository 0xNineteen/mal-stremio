const DEFAULT_BACKDROP = '/goku-backdrop.jpg';
const DEFAULT_LOGO = '/dragon-ball.svg';

const STYLESHEET = `
* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  width: 100%;
  min-height: 100%;
}

html {
  background:
    linear-gradient(135deg, rgba(8, 14, 42, 0.82), rgba(120, 35, 0, 0.55)),
    url('${DEFAULT_BACKDROP}') center center / cover no-repeat fixed;
}

body {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3vh 2vh;
  font-family: 'Nunito', 'Segoe UI', sans-serif;
  color: #fff7ef;
}

#addon {
  width: min(46vh, 92vw);
  padding: 3.2vh 3vh 2.8vh;
  border-radius: 2vh;
  background: rgba(10, 16, 38, 0.72);
  border: 1px solid rgba(255, 170, 64, 0.35);
  box-shadow:
    0 2vh 5vh rgba(0, 0, 0, 0.45),
    0 0 4vh rgba(255, 120, 0, 0.18),
    inset 0 0 0 1px rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}

.logo {
  width: 12vh;
  height: 12vh;
  margin: 0 auto 2vh;
  filter: drop-shadow(0 0 1.2vh rgba(255, 153, 0, 0.65));
}

.logo img {
  width: 100%;
  height: 100%;
}

.badge {
  display: inline-block;
  margin-bottom: 1.2vh;
  padding: 0.5vh 1.4vh;
  border-radius: 999px;
  background: linear-gradient(90deg, rgba(255, 122, 0, 0.35), rgba(36, 99, 235, 0.35));
  border: 1px solid rgba(255, 180, 80, 0.45);
  font-size: 1.35vh;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-weight: 700;
}

h1 {
  margin: 0;
  font-family: 'Bangers', cursive;
  font-size: 5vh;
  letter-spacing: 0.04em;
  line-height: 1;
  text-shadow:
    0 0.2vh 0 #7a2500,
    0 0 2vh rgba(255, 153, 0, 0.55);
}

h2 {
  margin: 0.8vh 0 0;
  font-size: 1.9vh;
  font-weight: 600;
  color: rgba(255, 236, 210, 0.88);
}

.tagline {
  margin-top: 1.4vh;
  font-size: 1.75vh;
  line-height: 1.45;
  color: rgba(255, 244, 230, 0.82);
}

h3 {
  margin: 0 0 1vh;
  font-size: 1.9vh;
  font-weight: 700;
  color: #ffb347;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

ul {
  margin: 0;
  padding-left: 2.2vh;
  font-size: 1.7vh;
  color: rgba(255, 244, 230, 0.9);
}

li + li {
  margin-top: 0.4vh;
}

.separator {
  height: 1px;
  margin: 2.4vh 0;
  background: linear-gradient(90deg, transparent, rgba(255, 153, 0, 0.55), transparent);
}

.form-element {
  margin-bottom: 1.8vh;
}

.label-to-top {
  margin-bottom: 0.8vh;
  font-size: 1.55vh;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #ffd7a1;
}

.full-width {
  width: 100%;
  padding: 1.1vh 1.4vh;
  border-radius: 0.9vh;
  border: 1px solid rgba(255, 170, 64, 0.35);
  background: rgba(7, 12, 30, 0.75);
  color: #fff8ef;
  font-size: 1.8vh;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.full-width:focus {
  border-color: #ff8f1f;
  box-shadow: 0 0 0 0.3vh rgba(255, 143, 31, 0.25);
}

a.install-link {
  text-decoration: none;
}

button {
  width: 100%;
  border: 0;
  outline: 0;
  cursor: pointer;
  padding: 1.3vh 2vh;
  border-radius: 1vh;
  font-family: 'Nunito', 'Segoe UI', sans-serif;
  font-size: 2vh;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  transition: transform 0.12s ease, box-shadow 0.12s ease, filter 0.12s ease;
}

button:hover {
  transform: translateY(-0.15vh);
  filter: brightness(1.05);
}

button:active {
  transform: translateY(0.1vh);
}

button.primary {
  color: #2b1300;
  background: linear-gradient(135deg, #ffb347 0%, #ff7a00 55%, #ff5400 100%);
  box-shadow: 0 0.8vh 2vh rgba(255, 102, 0, 0.35);
}

button.secondary {
  margin-top: 1.2vh;
  color: #eaf2ff;
  background: rgba(24, 64, 170, 0.55);
  border: 1px solid rgba(120, 170, 255, 0.45);
  box-shadow: 0 0.6vh 1.6vh rgba(20, 50, 140, 0.28);
}

.link-hint {
  margin-top: 1.4vh;
  padding: 1vh 1.2vh;
  border-radius: 0.8vh;
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 1.25vh;
  line-height: 1.4;
  color: rgba(255, 240, 220, 0.72);
  word-break: break-all;
  text-align: center;
}
`;

function buildFormHTML(manifest) {
  let options = '';

  (manifest.config || []).forEach(elem => {
    const key = elem.key;
    if (['text', 'number', 'password'].includes(elem.type)) {
      const isRequired = elem.required ? ' required' : '';
      const defaultHTML = elem.default ? ` value="${elem.default}"` : '';
      options += `
      <div class="form-element">
        <div class="label-to-top">${elem.title}</div>
        <input type="${elem.type}" id="${key}" name="${key}" class="full-width" placeholder="${key === 'username' ? 'optional — for personal list catalogs' : ''}"${defaultHTML}${isRequired}/>
      </div>
      `;
    }
  });

  if (!options.length) return '';

  return `
  <form class="pure-form" id="mainForm">
    ${options}
  </form>
  <div class="separator"></div>
  `;
}

function configurePage(manifest) {
  const background = manifest.background || DEFAULT_BACKDROP;
  const logo = manifest.logo || DEFAULT_LOGO;
  const formHTML = buildFormHTML(manifest);
  const stylizedTypes = manifest.types
    .map(t => t[0].toUpperCase() + t.slice(1) + (t !== 'series' ? 's' : ''));

  const stylesheet = STYLESHEET.replace(DEFAULT_BACKDROP, background);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${manifest.name} - Stremio Addon</title>
  <style>${stylesheet}</style>
  <link rel="shortcut icon" href="${logo}" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bangers&family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet">
</head>
<body>
  <div id="addon">
    <div class="logo">
      <img src="${logo}" alt="Dragon Ball">
    </div>
    <div class="badge">Anime Addon</div>
    <h1 class="name">${manifest.name}</h1>
    <h2 class="version">v${manifest.version || '0.0.0'}</h2>
    <p class="tagline">Top-rated seasonal anime plus your personal MAL lists — Watching, Completed, On Hold, and Plan to Watch. Enter your MAL username for personal list catalogs (optional).</p>

    <div class="separator"></div>

    <h3>Provides</h3>
    <ul>
      ${stylizedTypes.map(t => `<li>${t}</li>`).join('')}
    </ul>

    <div class="separator"></div>

    ${formHTML}

    <a id="installLink" class="install-link" href="#">
      <button type="button" class="primary" name="Install">Install Addon</button>
    </a>
    <button id="copyLinkBtn" type="button" class="secondary">Copy Link</button>
    <p class="link-hint" id="linkHint"></p>
  </div>
  <script>
    const mainForm = document.getElementById('mainForm')
    const installLink = document.getElementById('installLink')
    const copyLinkBtn = document.getElementById('copyLinkBtn')
    const linkHint = document.getElementById('linkHint')

    const getConfig = () => {
      const raw = Object.fromEntries(new FormData(mainForm))
      const username = (raw.username || '').trim()
      return username ? { username } : {}
    }

    const getManifestUrl = () => {
      const config = getConfig()
      const configPart = encodeURIComponent(JSON.stringify(config))
      const timestamp = Date.now()
      return window.location.protocol + '//' + window.location.host + '/' + configPart + '/manifest.json?t=' + timestamp
    }

    const updateLinks = () => {
      if (!mainForm.reportValidity()) return
      const manifestUrl = getManifestUrl()
      installLink.href = manifestUrl.replace(/^https?:/, 'stremio')
      linkHint.textContent = manifestUrl
    }

    installLink.onclick = () => mainForm.reportValidity()

    copyLinkBtn.onclick = async () => {
      if (!mainForm.reportValidity()) return
      const url = getManifestUrl()
      try {
        await navigator.clipboard.writeText(url)
      } catch (_) {
        const ta = document.createElement('textarea')
        ta.value = url
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      const original = copyLinkBtn.textContent
      copyLinkBtn.textContent = 'Copied!'
      setTimeout(() => { copyLinkBtn.textContent = original }, 2000)
    }

    mainForm.addEventListener('input', updateLinks)
    mainForm.addEventListener('change', updateLinks)
    updateLinks()
  </script>
</body>
</html>`;
}

module.exports = configurePage;