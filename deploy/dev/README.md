# Biomapper UI Dev Deployment

Step-by-step guide for deploying the dev instance of biomapper-ui to an AWS Lightsail instance.

Replace `$DEPLOY_DIR` with `/home/ubuntu/biomapper-ui-dev` and `$DOMAIN` with `dev-link.expertintheloop.io` throughout.

## Prerequisites

- Node.js 20+
- pnpm 9+ (already available from initial server setup; `corepack enable` is NOT required)
- Python 3.11+
- uv or pip (for Python dependencies)
- nginx
- certbot (for SSL)

## 1. DNS Setup (Do Early)

Create an A record pointing `$DOMAIN` to your Lightsail instance IP. DNS propagation can take minutes to hours, so do this first.

```bash
# Check propagation status later with:
dig +short $DOMAIN
```

## 2. Clone Repository

```bash
ssh ubuntu@<LIGHTSAIL_IP>
cd ~
git clone https://github.com/Phenome-Health/biomapper-ui.git biomapper-ui-dev
cd biomapper-ui-dev
```

## 3. Install Dependencies

```bash
# Node dependencies
pnpm install

# Python venv at repo root (first-time only — subsequent CI deploys must NOT recreate the venv)
cd $DEPLOY_DIR
~/.local/bin/uv venv .venv --python 3.11
~/.local/bin/uv pip install --python .venv/bin/python -r artifacts/python-api/requirements.txt
```

Note: The venv at `$DEPLOY_DIR/.venv` is created once during initial setup. The CI deploy workflow only syncs dependencies into the existing venv using `uv pip install --python .venv/bin/python`.

## 4. Build

The frontend build bakes in `VITE_*` environment variables. Only export those — do not source the full `.env` to avoid leaking backend secrets.

```bash
# Export only VITE_* vars for the frontend build
set -a; source <(grep '^VITE_' "$DEPLOY_DIR/.env" 2>/dev/null); set +a

# Build only production workspaces (skip mockup-sandbox which needs Replit env vars)
pnpm run typecheck
PORT=5173 BASE_PATH="/" pnpm --filter @workspace/frontend run build
pnpm --filter @workspace/api-server run build
```

### Post-Build Verification

Confirm the Clerk proxy URL was baked into the frontend build (if Clerk is active):

```bash
grep -r "/__clerk" $DEPLOY_DIR/artifacts/frontend/dist/public/
```

You should see the proxy URL in the bundled JS files. If Clerk is disabled, this may not appear.

## 5. Create Environment File

```bash
cp deploy/dev/.env.example $DEPLOY_DIR/.env
# Edit .env with your actual values:
nano $DEPLOY_DIR/.env
```

## 6. Systemd Services

Copy service files from `deploy/dev/`, replace the `$DEPLOY_DIR` placeholder, enable and start:

```bash
# Express API server
sudo cp deploy/dev/biomapper-ui-dev-express.service /etc/systemd/system/
sudo sed -i "s|\$DEPLOY_DIR|$DEPLOY_DIR|g" /etc/systemd/system/biomapper-ui-dev-express.service

# Python API server
sudo cp deploy/dev/biomapper-ui-dev-python.service /etc/systemd/system/
sudo sed -i "s|\$DEPLOY_DIR|$DEPLOY_DIR|g" /etc/systemd/system/biomapper-ui-dev-python.service

# Reload, enable, and start
sudo systemctl daemon-reload
sudo systemctl enable biomapper-ui-dev-express biomapper-ui-dev-python
sudo systemctl start biomapper-ui-dev-express biomapper-ui-dev-python
```

### Service Management

```bash
# Check status
sudo systemctl status biomapper-ui-dev-express
sudo systemctl status biomapper-ui-dev-python

# View logs
sudo journalctl -u biomapper-ui-dev-express -f
sudo journalctl -u biomapper-ui-dev-python -f

# Restart
sudo systemctl restart biomapper-ui-dev-express biomapper-ui-dev-python
```

## 7. Nginx Configuration

```bash
# Copy config and replace placeholder
sudo cp deploy/dev/nginx-dev-link.conf /etc/nginx/sites-available/dev-link.conf
sudo sed -i "s|\$DEPLOY_DIR|$DEPLOY_DIR|g" /etc/nginx/sites-available/dev-link.conf

# Enable site
sudo ln -s /etc/nginx/sites-available/dev-link.conf /etc/nginx/sites-enabled/

# Test and reload
sudo nginx -t
sudo systemctl reload nginx
```

## 8. DNS Propagation Check

Before requesting an SSL certificate, confirm DNS has propagated:

```bash
dig +short $DOMAIN
# Should return your Lightsail instance IP
```

## 9. SSL Certificate (Certbot)

```bash
sudo certbot --nginx -d $DOMAIN
```

Certbot will modify the nginx config to add SSL listeners and redirects.

## 10. Clerk Dashboard Configuration

In the [Clerk Dashboard](https://dashboard.clerk.com/):

1. Navigate to your application settings
2. Update the redirect URLs to include `https://$DOMAIN`
3. If using a proxy, ensure the proxy URL `https://$DOMAIN/api/__clerk` is configured

**Important:** Clerk authentication will not work until all three are complete:
- DNS resolves to your server
- SSL certificate is active (HTTPS works)
- Clerk dashboard redirect URLs are updated

## 11. Verification

```bash
# Frontend loads
curl -s -o /dev/null -w "%{http_code}" https://$DOMAIN/

# Express API responds
curl -s https://$DOMAIN/api/health

# Python API responds (internal only)
curl -s http://127.0.0.1:8005/health

# Services are running
sudo systemctl is-active biomapper-ui-dev-express
sudo systemctl is-active biomapper-ui-dev-python
```

## Notes

- **systemd EnvironmentFile precedence:** When services run via systemd, values from `EnvironmentFile` take precedence over any `load_dotenv()` calls in code. When running manually for debugging, the `.env` file is loaded by `load_dotenv()` instead.
- **load_dotenv resolution:** `main.py`'s `load_dotenv()` resolves `.env` via three parent levels from `artifacts/python-api/`, which maps to `$DEPLOY_DIR/.env`.
- **Rebuilds:** If you change any `VITE_*` environment variable, you must rebuild the frontend -- these are baked in at build time.
- **Biomapper2 API:** The Python API proxies requests to the biomapper2 backend. Ensure `BIOMAPPER_BASE_URL` in `.env` points to the correct biomapper2 API instance (dev biomapper2 at port 8003).
