# Biomapper UI Deployment

Step-by-step guide for deploying biomapper-ui to an AWS Lightsail instance.

Replace `$DEPLOY_DIR` with your actual deployment path (e.g., `/home/ubuntu/biomapper-ui`) and `$DOMAIN` with your domain (e.g., `link.expertintheloop.io`) throughout.

## Prerequisites

- Node.js 20+
- pnpm 9+
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
git clone https://github.com/Phenome-Health/biomapper-ui.git
cd biomapper-ui
```

## 3. Install Dependencies

```bash
# Node dependencies
corepack enable
pnpm install

# Python dependencies (in packages/python-api)
cd packages/python-api
uv venv && uv pip install -r requirements.txt
# or: python3 -m venv .venv && pip install -r requirements.txt
cd ../..
```

## 4. Build

The frontend build bakes in Clerk environment variables, so they must be set at build time:

```bash
VITE_CLERK_PUBLISHABLE_KEY=pk_live_... \
VITE_CLERK_PROXY_URL=https://$DOMAIN/api/__clerk \
pnpm build
```

### Post-Build Verification

Confirm the Clerk proxy URL was baked into the frontend build:

```bash
grep -r "/__clerk" $DEPLOY_DIR/artifacts/frontend/dist/public/
```

You should see the proxy URL in the bundled JS files. If not, rebuild with the correct `VITE_CLERK_PROXY_URL`.

## 5. Create Environment File

```bash
cp deploy/.env.example $DEPLOY_DIR/.env
# Edit .env with your actual values:
nano $DEPLOY_DIR/.env
```

## 6. Systemd Services

Copy service files, replace the `$DEPLOY_DIR` placeholder, enable and start:

```bash
# Express API server
sudo cp deploy/biomapper-ui-express.service /etc/systemd/system/
sudo sed -i "s|\$DEPLOY_DIR|$DEPLOY_DIR|g" /etc/systemd/system/biomapper-ui-express.service

# Python API server
sudo cp deploy/biomapper-ui-python.service /etc/systemd/system/
sudo sed -i "s|\$DEPLOY_DIR|$DEPLOY_DIR|g" /etc/systemd/system/biomapper-ui-python.service

# Reload, enable, and start
sudo systemctl daemon-reload
sudo systemctl enable biomapper-ui-express biomapper-ui-python
sudo systemctl start biomapper-ui-express biomapper-ui-python
```

### Service Management

```bash
# Check status
sudo systemctl status biomapper-ui-express
sudo systemctl status biomapper-ui-python

# View logs
sudo journalctl -u biomapper-ui-express -f
sudo journalctl -u biomapper-ui-python -f

# Restart
sudo systemctl restart biomapper-ui-express biomapper-ui-python
```

## 7. Nginx Configuration

```bash
# Copy config and replace placeholder
sudo cp deploy/nginx-link.conf /etc/nginx/sites-available/link.conf
sudo sed -i "s|\$DEPLOY_DIR|$DEPLOY_DIR|g" /etc/nginx/sites-available/link.conf

# Enable site
sudo ln -s /etc/nginx/sites-available/link.conf /etc/nginx/sites-enabled/

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
curl -s http://127.0.0.1:8000/health

# Services are running
sudo systemctl is-active biomapper-ui-express
sudo systemctl is-active biomapper-ui-python
```

## Notes

- **systemd EnvironmentFile precedence:** When services run via systemd, values from `EnvironmentFile` take precedence over any `load_dotenv()` calls in code. When running manually for debugging, the `.env` file is loaded by `load_dotenv()` instead.
- **Rebuilds:** If you change any `VITE_*` environment variable, you must rebuild the frontend -- these are baked in at build time.
- **Biomapper2 API:** The Python API proxies requests to the biomapper2 backend. Ensure `BIOMAPPER_BASE_URL` in `.env` points to the correct biomapper2 API instance.
