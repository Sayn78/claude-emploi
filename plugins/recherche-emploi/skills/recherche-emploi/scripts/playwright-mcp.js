#!/usr/bin/env node
// Lance Playwright MCP pour le compte du plugin, et se contente de relayer les
// flux : Claude Code parle au serveur comme s'il l'avait lance lui-meme.
//
// Pourquoi ce detour plutot qu'un "command": "npx" dans .mcp.json ? Sous
// Windows, npx est un fichier .cmd : le lancer sans passer par un shell echoue
// en ENOENT, et le nommer npx.cmd echoue en EINVAL depuis que Node refuse
// d'executer un batch sans shell. Les deux cas ont ete verifies. On passe donc
// explicitement par cmd.exe, plutot que par shell:true qui concatene les
// arguments sans les echapper. Aucune dependance ajoutee au passage : Node est
// deja requis par le skill.
//
// Le navigateur reste visible, sans --headless : c'est plus fiable face aux
// protections anti-robot, et l'utilisateur peut resoudre lui-meme un captcha.

const { spawn } = require('node:child_process');

const win = process.platform === 'win32';
const args = ['--yes', '@playwright/mcp@latest', '--browser', 'chrome', ...process.argv.slice(2)];

const enfant = win
  ? spawn(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', 'npx', ...args], { stdio: 'inherit', windowsVerbatimArguments: false })
  : spawn('npx', args, { stdio: 'inherit' });

enfant.on('error', (e) => {
  process.stderr.write('Playwright MCP n a pas pu demarrer : ' + e.message + '\n' +
    'Verifie que Node et npx sont installes, puis relance Claude Code.\n');
  process.exit(1);
});
enfant.on('exit', (code, signal) => process.exit(signal ? 1 : (code === null ? 0 : code)));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { enfant.kill(sig); } catch {} });
}
