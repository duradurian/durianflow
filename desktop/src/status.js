const shell = document.getElementById("shell");
const message = document.getElementById("message");

window.openflow.onStatusUpdate((status) => {
  shell.className = `shell ${status.state || "ready"}`;
  message.textContent = status.message || "Ready";
});
