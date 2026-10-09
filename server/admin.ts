/**
 * The admin's command line: make accounts, reset passwords, grant rights. It opens the same
 * database file as the server (safe while the server runs), so it works with no web page and
 * no login - which is also how the first admin comes to exist.
 *
 *   npm run admin -- list
 *   npm run admin -- create <name> [--admin]    makes the account, prints its password once
 *   npm run admin -- reset-password <name>      new random password; logs the user out everywhere
 *   npm run admin -- role <name> user|admin
 *   npm run admin -- grant <name> <right>       rights: generate-maps
 *   npm run admin -- revoke <name> <right>
 *   npm run admin -- disable <name>             (enable <name> undoes it)
 *   npm run admin -- delete <name> --yes        removes the account and its maps
 *
 *   DB_PATH=...   which database (default data/game.db)
 * In Docker: docker compose exec game npm run admin -- list
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RIGHTS, ROLES, StoreError, type Right, type Role, type Store, type User } from './store/Store';
import { SqliteStore } from './store/SqliteStore';
import { generatePassword, hashPassword } from './auth/password';

const USAGE = `Usage: npm run admin -- <command>
  list
  create <name> [--admin]
  reset-password <name>
  role <name> user|admin
  grant <name> <right>      (${RIGHTS.join(', ')})
  revoke <name> <right>
  disable <name> | enable <name>
  delete <name> --yes`;

/** Runs one command; returns the process exit code. `out` gets the output, one line a call. */
export async function runAdmin(args: string[], store: Store, out: (line: string) => void): Promise<number> {
  const flags = args.filter((a) => a.startsWith('--'));
  const [command, name, extra] = args.filter((a) => !a.startsWith('--'));
  const find = (): User => {
    const found = name ? store.findUserForLogin(name) : null;
    if (!found) throw new Error(name ? `There is no account "${name}".` : 'Give an account name.');
    return found;
  };
  try {
    switch (command) {
      case 'list': {
        for (const u of store.listUsers()) {
          const rights = u.role === 'admin' ? 'all rights' : u.rights.join(',') || '-';
          out(`${String(u.id).padStart(4)}  ${u.name.padEnd(16)} ${u.role.padEnd(5)} ${rights}${u.disabled ? '  DISABLED' : ''}`);
        }
        return 0;
      }
      case 'create': {
        if (!name) throw new Error('Give a name for the account.');
        const password = generatePassword();
        const user = store.createUser(name, await hashPassword(password), flags.includes('--admin') ? 'admin' : 'user');
        out(`Created ${user.role} "${user.name}" with password: ${password}`);
        out('Shown once. They can change it from the game.');
        return 0;
      }
      case 'reset-password': {
        const user = find();
        const password = generatePassword();
        store.setPasswordHash(user.id, await hashPassword(password));
        out(`New password for "${user.name}": ${password}`);
        out('Shown once. Their other logins have ended.');
        return 0;
      }
      case 'role': {
        const user = find();
        if (!ROLES.includes(extra as Role)) throw new Error(`The role is one of: ${ROLES.join(', ')}.`);
        store.setRole(user.id, extra as Role);
        out(`"${user.name}" is now ${extra}.`);
        return 0;
      }
      case 'grant':
      case 'revoke': {
        const user = find();
        if (!RIGHTS.includes(extra as Right)) throw new Error(`The right is one of: ${RIGHTS.join(', ')}.`);
        const rights = new Set(user.rights);
        if (command === 'grant') rights.add(extra as Right);
        else rights.delete(extra as Right);
        store.setRights(user.id, [...rights]);
        out(`"${user.name}" now has: ${[...rights].join(', ') || 'no extra rights'}.`);
        return 0;
      }
      case 'disable':
      case 'enable': {
        const user = find();
        store.setDisabled(user.id, command === 'disable');
        out(`"${user.name}" is ${command}d.`);
        return 0;
      }
      case 'delete': {
        const user = find();
        if (!flags.includes('--yes')) throw new Error(`This removes "${user.name}" and their maps for good: add --yes.`);
        store.deleteUser(user.id);
        out(`Deleted "${user.name}".`);
        return 0;
      }
      default:
        out(USAGE);
        return command ? 1 : 0;
    }
  } catch (e) {
    if (e instanceof StoreError || e instanceof Error) {
      out(`Error: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

// Run directly (not imported by a test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = new SqliteStore(process.env.DB_PATH || fileURLToPath(new URL('../data/game.db', import.meta.url)));
  runAdmin(process.argv.slice(2), store, console.log)
    .then((code) => {
      store.close();
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
