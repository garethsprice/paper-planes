/** Keep recovery usable even when renderer construction or a module fails. */
const recovery = document.getElementById('recovery')!;
function showRecovery(message: string) {
  recovery.hidden = false;
  document.getElementById('recovery-message')!.textContent = message;
  document.getElementById('invite')!.hidden = true;
  document.getElementById('ui')!.hidden = true;
}
document.getElementById('retry')!.addEventListener('click', () => location.reload());
document.getElementById('stage')!.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  showRecovery('The graphics connection was interrupted. Reload to return to your flight.');
});
import('./main.ts').catch((error: unknown) => {
  console.error('Paper Planes could not start:', error);
  showRecovery('The 3D scene could not start. Check hardware acceleration in your browser, then try again.');
});
