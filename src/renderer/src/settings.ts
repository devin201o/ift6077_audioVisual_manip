/** Settings + privacy dialogs. The key goes to the main process once and is never read back. */
export function setupSettings() {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dlg = $<HTMLDialogElement>('settings'), priv = $<HTMLDialogElement>('privacy');
  const keyIn = $<HTMLInputElement>('keyin'), modelIn = $<HTMLInputElement>('modelin');
  const keyState = $('keystate'), err = $('seterr');
  let st = { model: '', hasKey: false, privacyAck: false, canEncrypt: true };

  const show = () => {
    modelIn.value = st.model;
    keyState.textContent = !st.canEncrypt ? 'Secure key storage is not available on this system.' : st.hasKey ? 'Key saved ✓ (stored encrypted, never shown again)' : 'No key yet. Chips are still created, without analysis.';
    $('rmkey').hidden = !st.hasKey;
  };
  const fail = (e: unknown) => { err.hidden = false; err.textContent = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); };
  const askPrivacy = () => new Promise<boolean>((res) => {
    priv.showModal();
    priv.addEventListener('close', () => res(priv.returnValue === 'yes'), { once: true });
  });
  $('privyes').onclick = () => { priv.returnValue = 'yes'; priv.close(); };
  $('privno').onclick = () => { priv.returnValue = 'no'; priv.close(); };

  $('setsave').onclick = async () => {
    err.hidden = true;
    try {
      if (modelIn.value.trim() && modelIn.value.trim() !== st.model) st = await window.lib.settings.setModel(modelIn.value);
      const key = keyIn.value.trim();
      if (key) {
        if (!st.privacyAck && !(await askPrivacy())) return; // cancelled: nothing saved, nothing sent
        st = await window.lib.settings.setKey(key, true);
        keyIn.value = '';
      }
      show();
      dlg.close(); // saved
    } catch (e) { fail(e); }
  };
  $('rmkey').onclick = async () => { try { st = await window.lib.settings.clearKey(); show(); } catch (e) { fail(e); } };
  $('reall').onclick = async () => { try { await window.lib.reanalyze(); dlg.close(); } catch (e) { fail(e); } };
  $('setclose').onclick = () => dlg.close();

  return {
    async open() {
      err.hidden = true; keyIn.value = '';
      st = await window.lib.settings.get(); show();
      const n = st.hasKey ? await window.lib.outdated() : 0;
      $('reall').hidden = n === 0;
      $('reall').textContent = `Re-analyze ${n} outdated chip${n === 1 ? '' : 's'}`;
      if (!dlg.open) dlg.showModal();
    },
  };
}
