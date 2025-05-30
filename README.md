# QuiLLMan: Voice Chat with Moshi

A complete voice chat app powered by a speech-to-speech language model and bidirectional streaming.

On the backend is Kyutai Lab's [Moshi](https://github.com/kyutai-labs/moshi) model, which will continuously listen, plan, and respond to the user. It uses the [Mimi](https://huggingface.co/kyutai/mimi) streaming encoder/decoder model to maintain an unbroken stream of audio in and out, and a [speech-text foundation model](https://huggingface.co/kyutai/moshiko-pytorch-bf16) to determine when and how to respond.

Thanks to bidirectional websocket streaming and use of the [Opus audio codec](https://opus-codec.org/) for compressing audio across the network, response times on good internet can be nearly instantaneous, closely matching the cadence of human speech.

You can find the demo live [here](https://modal-labs--quillman-web.modal.run/).

![Quillman](https://github.com/user-attachments/assets/afda5874-8509-4f56-9f25-d734b8f1c40a)

This repo is meant to serve as a starting point for your own language model-based apps, as well as a playground for experimentation. Contributions are welcome and encouraged!

[Note: this code is provided for illustration only; please remember to check the license before using any model for commercial purposes.]

## File structure

1. React frontend ([`src/frontend/`](./src/frontend/)), a Vite application.
2. Moshi websocket server ([`src/moshi.py`](./src/moshi.py)), along with a minimal FastAPI wrapper in [`src/app.py`](./src/app.py) for Modal deployment.

## Developing locally

### Requirements

- `modal` installed in your current Python virtual environment (`pip install modal`)
- A [Modal](http://modal.com/) account (`modal setup`)
- A Modal token set up in your environment (`modal token new`)

### Developing the inference module

The Moshi server is a [Modal class](https://modal.com/docs/reference/modal.Cls#modalcls) module to load the models and maintain streaming state, with a [FastAPI](https://fastapi.tiangolo.com/) http server to expose a websocket interface over the internet.

To run a [development server](https://modal.com/docs/guide/webhooks#developing-with-modal-serve) for the Moshi module, run this command from the root of the repo.

```shell
modal serve -m src.moshi
```

In the terminal output, you'll find a URL for creating a websocket connection.

While the `modal serve` process is running, changes to any of the project files will be automatically applied. `Ctrl+C` will stop the app.

### Testing the websocket connection

From a seperate terminal, we can test the websocket connection directly from the command line with the `tests/moshi_client.py` client.

It requires non-standard dependencies, which can be installed with:

```shell
python -m venv venv
source venv/bin/activate
pip install -r requirements/requirements-dev.txt
```

With dependencies installed, run the terminal client with:

```shell
python tests/moshi_client.py
```

And begin speaking! Be sure to have your microphone and speakers enabled.

### Developing the Backend (Moshi Service)

The `src/app.py` file is the main entry point for running the Modal backend, which includes the Moshi WebSocket service from `src/moshi.py`.

To run a local development server for the backend:
```shell
modal serve src.app
```
This command starts the Moshi WebSocket server. Modal will provide a WebSocket URL (e.g., `ws://localhost:8000/ws` or similar, check the output of `modal serve`). You'll use this URL for local frontend development.

Changes to backend Python files will be automatically applied while `modal serve` is running. Press `Ctrl+C` to stop.

### Developing the Frontend (Vite + React)

The frontend is a Vite-powered React application located in `src/frontend/`.

1.  **Navigate to the frontend directory:**
    ```bash
    cd src/frontend
    ```

2.  **Install dependencies (if you haven't already):**
    ```bash
    npm install
    ```

3.  **Configure Backend URL:**
    Create a `.env` file in the `src/frontend/` directory (you can copy `.env.example`). Set the `VITE_MOSHI_WS_URL` to the WebSocket URL provided by your local `modal serve src.app` process. For example:
    ```env
    VITE_MOSHI_WS_URL=ws://localhost:8000/ws 
    ```
    *(Note: The exact port for the local Modal WebSocket might vary; check the output of `modal serve`)*

4.  **Run the Vite development server:**
    ```bash
    npm run dev
    ```
    This will typically start the frontend on `http://localhost:5173` and open it in your browser. Changes to frontend files (e.g., in `src/frontend/main.jsx`) will trigger hot module replacement.

## Deployment

This application uses a hybrid deployment model:
- The **frontend** (React user interface) is deployed to Vercel.
- The **backend** (FastAPI server and the Moshi AI service) is deployed to Modal.

### 1. Deploying Backend to Modal

The backend, which includes the real-time audio processing AI (`Moshi`), requires GPU resources and is deployed using Modal.

1.  **Install Modal Client and Authenticate (if not done previously):**
    ```bash
    pip install modal-client
    modal token new
    ```
    Follow the instructions to authenticate.

2.  **Deploy the Application:**
    The main application entry point for Modal is `src/app.py`, which also deploys the `Moshi` service.
    ```bash
    modal deploy src.app --name your-app-name
    ```
    Replace `your-app-name` with a unique name for your deployment (e.g., `moshi-chat-app`).

3.  **Obtain Moshi WebSocket URL:**
    After deployment, Modal will output the URLs for your services. Look for the URL corresponding to the `Moshi` WebSocket endpoint. It will typically look like:
    `wss://your-app-name-moshi-web.modal.run/ws`
    You will need this URL for the frontend deployment on Vercel.

### 2. Deploying Frontend to Vercel

The frontend is a Vite-based React application that can be easily deployed to Vercel.

1.  **Push to Git:**
    Ensure your latest code, including the `vercel.json` file at the repository root and the updated frontend in `src/frontend/`, is pushed to your GitHub, GitLab, or Bitbucket repository.

2.  **Create Vercel Project:**
    - Log in to your Vercel account.
    - Click "Add New..." -> "Project".
    - Import your Git repository.

3.  **Configure Project Settings:**
    - Vercel should automatically detect the Vite configuration due to the `vercel.json` file and the frontend structure. The `vercel.json` specifies that the frontend is in `src/frontend/` and how to build it.
    - **Set Environment Variable (Crucial):**
        - Navigate to your project settings in Vercel (Settings -> Environment Variables).
        - Add a new environment variable:
            - **Name:** `VITE_MOSHI_WS_URL`
            - **Value:** Paste the Moshi WebSocket URL you obtained from the Modal deployment (e.g., `wss://your-app-name-moshi-web.modal.run/ws`).

4.  **Deploy:**
    - Click the "Deploy" button. Vercel will build the frontend (running `npm run build` in the `src/frontend` directory as specified by `vercel.json`) and deploy it.

5.  **Access Your Site:**
    Once deployed, Vercel will provide you with a URL to access your live frontend.
