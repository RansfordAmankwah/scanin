import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { createPool } from '../db/pool.js';
import {
  assignLecturer,
  createCourse,
  createLecturer,
  createTerm,
  endAssignment,
  OperatorError,
} from './commands.js';

const USAGE = `ScanIn operator CLI (provisioning only; connects as the operator database role)

Usage: pnpm --filter @scanin/api operator <command> [options]

Commands:
  create-term       --name <name> --starts <YYYY-MM-DD> --ends <YYYY-MM-DD>
  create-course     --term <term name> --code <code> --title <title>
  create-lecturer   --email <email> --name <full name>      (prints a temporary password once)
  assign-lecturer   --term <term name> --course <code> --email <lecturer email>
  end-assignment    --term <term name> --course <code> --email <lecturer email>

Environment:
  OPERATOR_DATABASE_URL   connection string for the operator role (required)
`;

function need(values: Record<string, string | boolean | undefined>, key: string): string {
  const v = values[key];
  if (typeof v !== 'string' || !v.trim()) throw new OperatorError(`Missing --${key}`);
  return v;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      starts: { type: 'string' },
      ends: { type: 'string' },
      term: { type: 'string' },
      code: { type: 'string' },
      title: { type: 'string' },
      email: { type: 'string' },
      course: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  const command = positionals[0];
  if (!command || values.help) {
    console.log(USAGE);
    return;
  }
  const url = process.env.OPERATOR_DATABASE_URL;
  if (!url) throw new OperatorError('OPERATOR_DATABASE_URL is not set.');

  const pool = createPool(url);
  const operator = userInfo().username;
  try {
    switch (command) {
      case 'create-term': {
        const r = await createTerm(pool, {
          operator,
          name: need(values, 'name'),
          startsOn: need(values, 'starts'),
          endsOn: need(values, 'ends'),
        });
        console.log(`Created term ${r.id}`);
        break;
      }
      case 'create-course': {
        const r = await createCourse(pool, {
          operator,
          term: need(values, 'term'),
          code: need(values, 'code'),
          title: need(values, 'title'),
        });
        console.log(`Created course ${r.id}`);
        break;
      }
      case 'create-lecturer': {
        const r = await createLecturer(pool, {
          operator,
          email: need(values, 'email'),
          fullName: need(values, 'name'),
        });
        console.log(`Created lecturer ${r.id}`);
        console.log('Temporary password (shown once; give it to the lecturer securely):');
        console.log(r.temporaryPassword);
        break;
      }
      case 'assign-lecturer': {
        const r = await assignLecturer(pool, {
          operator,
          term: need(values, 'term'),
          courseCode: need(values, 'course'),
          lecturerEmail: need(values, 'email'),
        });
        console.log(r.reactivated ? 'Assignment reactivated.' : 'Lecturer assigned.');
        break;
      }
      case 'end-assignment': {
        await endAssignment(pool, {
          operator,
          term: need(values, 'term'),
          courseCode: need(values, 'course'),
          lecturerEmail: need(values, 'email'),
        });
        console.log('Assignment ended.');
        break;
      }
      default:
        throw new OperatorError(`Unknown command "${command}".\n\n${USAGE}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof OperatorError) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error('Unexpected error:', (err as Error).message);
  }
  process.exitCode = 1;
});
