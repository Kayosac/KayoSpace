/**
 * Формулы в таблицах (решение 0023): колонка «Формула» считает значение для каждой строки.
 *
 *   [Цена] * [Количество]          — колонки по названию в квадратных скобках
 *   ROUND([Сумма] * 1.12; 2)       — функции; аргументы через «;» или «,»
 *   IF([Готово]; "да"; "нет")      — условия, сравнения = <> < > <= >=
 *   SUM([Цена])                    — колонка целиком в SUM/AVG/MIN/MAX/COUNT — по всем строкам
 *   [Имя] & " — " & [Город]        — склейка строк
 *   DAYS([Срок]; TODAY())          — разница дат в днях
 *
 * Названия функций — латиницей или по-русски (ЕСЛИ, ОКРУГЛ, СУММ, СРЗНАЧ…), регистр не важен.
 * Ошибка в формуле или цикл между формулами — ячейка показывает «#ОШИБКА» с причиной.
 */

export type Value = number | string | boolean | null;

export class FormulaError extends Error {}

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'col'; name: string }
  | { k: 'un'; op: '-' | '+'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; name: string; args: Node[] };

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'col'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: '('; v: '(' }
  | { t: ')'; v: ')' }
  | { t: 'sep'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
    } else if (c === '"' || c === '«') {
      const close = c === '"' ? '"' : '»';
      const end = src.indexOf(close, i + 1);
      if (end < 0) throw new FormulaError('не закрыта кавычка');
      out.push({ t: 'str', v: src.slice(i + 1, end) });
      i = end + 1;
    } else if (c === '[') {
      const end = src.indexOf(']', i + 1);
      if (end < 0) throw new FormulaError('не закрыта скобка «]»');
      out.push({ t: 'col', v: src.slice(i + 1, end).trim() });
      i = end + 1;
    } else if (/[\p{L}_]/u.test(c)) {
      const m = /^[\p{L}_][\p{L}\p{N}_.]*/u.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
    } else if (c === '(' || c === ')') {
      out.push({ t: c, v: c } as Tok);
      i++;
    } else if (c === ';' || c === ',') {
      out.push({ t: 'sep', v: c });
      i++;
    } else {
      const two = src.slice(i, i + 2);
      if (['<=', '>=', '<>', '!=', '=='].includes(two)) {
        out.push({ t: 'op', v: two === '!=' ? '<>' : two === '==' ? '=' : two });
        i += 2;
      } else if ('+-*/^&=<>'.includes(c)) {
        out.push({ t: 'op', v: c });
        i++;
      } else if (c === '×') {
        out.push({ t: 'op', v: '*' });
        i++;
      } else {
        throw new FormulaError(`непонятный знак «${c}»`);
      }
    }
  }
  return out;
}

/** Разбор: сравнение → склейка → сложение → умножение → степень → знак → значение. */
export function parseFormula(src: string): Node {
  const toks = tokenize(src.replace(/^=/, ''));
  let p = 0;
  const peek = (): Tok | undefined => toks[p];
  const isOp = (...ops: string[]): boolean => {
    const t = peek();
    return t?.t === 'op' && ops.includes(t.v);
  };
  const binary = (next: () => Node, ops: string[]) => (): Node => {
    let a = next();
    while (isOp(...ops)) {
      const op = (toks[p++] as { v: string }).v;
      a = { k: 'bin', op, a, b: next() };
    }
    return a;
  };
  const primary = (): Node => {
    const t = toks[p++];
    if (!t) throw new FormulaError('формула оборвалась');
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'col') return { k: 'col', name: t.v };
    if (t.t === '(') {
      const e = comparison();
      if (toks[p++]?.t !== ')') throw new FormulaError('не закрыта скобка «)»');
      return e;
    }
    if (t.t === 'id') {
      const up = t.v.toUpperCase();
      if (peek()?.t !== '(') {
        if (up === 'TRUE' || up === 'ИСТИНА') return { k: 'bool', v: true };
        if (up === 'FALSE' || up === 'ЛОЖЬ') return { k: 'bool', v: false };
        // Колонка без скобок, если имя из одного слова: Цена * Количество.
        return { k: 'col', name: t.v };
      }
      p++;
      const args: Node[] = [];
      if (peek()?.t !== ')') {
        args.push(comparison());
        while (peek()?.t === 'sep') {
          p++;
          args.push(comparison());
        }
      }
      if (toks[p++]?.t !== ')') throw new FormulaError(`не закрыта скобка у ${t.v}`);
      return { k: 'call', name: up, args };
    }
    throw new FormulaError(`неожиданное «${t.v}»`);
  };
  const unary = (): Node => {
    if (isOp('-', '+')) {
      const op = (toks[p++] as { v: string }).v as '-' | '+';
      return { k: 'un', op, a: unary() };
    }
    return primary();
  };
  const power = (): Node => {
    const a = unary();
    if (isOp('^')) {
      p++;
      return { k: 'bin', op: '^', a, b: power() };
    }
    return a;
  };
  const mul = binary(power, ['*', '/']);
  const add = binary(mul, ['+', '-']);
  const concat = binary(add, ['&']);
  const comparison = binary(concat, ['=', '<>', '<', '>', '<=', '>=']);
  if (!toks.length) throw new FormulaError('пустая формула');
  const tree = comparison();
  if (p < toks.length) throw new FormulaError(`лишнее «${toks[p]!.v}»`);
  return tree;
}

/** Колонки, на которые ссылается формула (по названию). */
export function formulaRefs(src: string): string[] {
  const out = new Set<string>();
  const walk = (n: Node): void => {
    if (n.k === 'col') out.add(n.name);
    else if (n.k === 'un') walk(n.a);
    else if (n.k === 'bin') {
      walk(n.a);
      walk(n.b);
    } else if (n.k === 'call') n.args.forEach(walk);
  };
  try {
    walk(parseFormula(src));
  } catch {
    // Ошибка разбора — ссылок нет.
  }
  return [...out];
}

const ALIASES: Record<string, string> = {
  ЕСЛИ: 'IF',
  ОКРУГЛ: 'ROUND',
  СУММ: 'SUM',
  СРЗНАЧ: 'AVG',
  AVERAGE: 'AVG',
  МИН: 'MIN',
  МАКС: 'MAX',
  СЧЁТ: 'COUNT',
  СЧЕТ: 'COUNT',
  ДЛСТР: 'LEN',
  СЦЕП: 'CONCAT',
  СЕГОДНЯ: 'TODAY',
  ДНИ: 'DAYS',
  И: 'AND',
  ИЛИ: 'OR',
  НЕ: 'NOT',
  ЕПУСТО: 'ISBLANK',
  ПРОПИСН: 'UPPER',
  СТРОЧН: 'LOWER',
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toNum(v: Value): number {
  if (v === null || v === '') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) throw new FormulaError(`«${v}» — не число`);
  return n;
}

const toStr = (v: Value): string =>
  v === null ? '' : typeof v === 'boolean' ? (v ? 'да' : 'нет') : String(v);

const truthy = (v: Value): boolean =>
  typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : !!v && v !== '0';

const dayNum = (v: Value): number => {
  const m = typeof v === 'string' ? DATE.exec(v) : null;
  if (!m) throw new FormulaError(`«${toStr(v)}» — не дата`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000;
};

export interface FormulaScope {
  /** Значение колонки в этой строке (колонки — по названию). */
  cell(name: string): Value;
  /** Все значения колонки (для SUM([Колонка]) и подобных). */
  column(name: string): Value[];
  /** Сегодня, YYYY-MM-DD. */
  today: string;
}

export function evaluate(n: Node, s: FormulaScope): Value {
  switch (n.k) {
    case 'num':
    case 'str':
    case 'bool':
      return n.v;
    case 'col':
      return s.cell(n.name);
    case 'un':
      return n.op === '-' ? -toNum(evaluate(n.a, s)) : toNum(evaluate(n.a, s));
    case 'bin': {
      const a = evaluate(n.a, s);
      const b = evaluate(n.b, s);
      switch (n.op) {
        case '+':
          return toNum(a) + toNum(b);
        case '-':
          return toNum(a) - toNum(b);
        case '*':
          return toNum(a) * toNum(b);
        case '/': {
          const d = toNum(b);
          if (d === 0) throw new FormulaError('деление на ноль');
          return toNum(a) / d;
        }
        case '^':
          return toNum(a) ** toNum(b);
        case '&':
          return toStr(a) + toStr(b);
        default: {
          // Сравнение: числа — как числа, иначе — как строки.
          const num = typeof a === 'number' || typeof b === 'number';
          const x = num ? toNum(a) : toStr(a).toLowerCase();
          const y = num ? toNum(b) : toStr(b).toLowerCase();
          if (n.op === '=') return x === y;
          if (n.op === '<>') return x !== y;
          if (n.op === '<') return x < y;
          if (n.op === '>') return x > y;
          if (n.op === '<=') return x <= y;
          return x >= y;
        }
      }
    }
    case 'call': {
      const name = ALIASES[n.name] ?? n.name;
      const args = n.args;
      const need = (min: number, max = min): void => {
        if (args.length < min || args.length > max)
          throw new FormulaError(
            `${n.name}: нужно аргументов — ${min === max ? min : `${min}–${max}`}`,
          );
      };
      // Колонка целиком — все её значения; иначе — значения аргументов.
      const spread = (): Value[] =>
        args.flatMap((a) =>
          a.k === 'col' && !isRowOnly(name) ? s.column(a.name) : [evaluate(a, s)],
        );
      const nums = (): number[] =>
        spread()
          .filter((v) => v !== null && v !== '')
          .map(toNum);
      switch (name) {
        case 'IF':
          need(2, 3);
          return truthy(evaluate(args[0]!, s))
            ? evaluate(args[1]!, s)
            : args[2]
              ? evaluate(args[2], s)
              : null;
        case 'ROUND': {
          need(1, 2);
          const k = 10 ** (args[1] ? toNum(evaluate(args[1], s)) : 0);
          return Math.round(toNum(evaluate(args[0]!, s)) * k) / k;
        }
        case 'ABS':
          need(1);
          return Math.abs(toNum(evaluate(args[0]!, s)));
        case 'SUM':
          return nums().reduce((a, b) => a + b, 0);
        case 'AVG': {
          const v = nums();
          if (!v.length) throw new FormulaError('СРЗНАЧ: нет чисел');
          return v.reduce((a, b) => a + b, 0) / v.length;
        }
        case 'MIN': {
          const v = nums();
          return v.length ? Math.min(...v) : null;
        }
        case 'MAX': {
          const v = nums();
          return v.length ? Math.max(...v) : null;
        }
        case 'COUNT':
          return spread().filter((v) => v !== null && v !== '' && v !== false).length;
        case 'LEN':
          need(1);
          return toStr(evaluate(args[0]!, s)).length;
        case 'UPPER':
          need(1);
          return toStr(evaluate(args[0]!, s)).toUpperCase();
        case 'LOWER':
          need(1);
          return toStr(evaluate(args[0]!, s)).toLowerCase();
        case 'CONCAT':
          return args.map((a) => toStr(evaluate(a, s))).join('');
        case 'TODAY':
          need(0);
          return s.today;
        case 'DAYS':
          need(2);
          return dayNum(evaluate(args[0]!, s)) - dayNum(evaluate(args[1]!, s));
        case 'AND':
          return args.every((a) => truthy(evaluate(a, s)));
        case 'OR':
          return args.some((a) => truthy(evaluate(a, s)));
        case 'NOT':
          need(1);
          return !truthy(evaluate(args[0]!, s));
        case 'ISBLANK': {
          need(1);
          const v = evaluate(args[0]!, s);
          return v === null || v === '';
        }
        default:
          throw new FormulaError(`нет функции ${n.name}`);
      }
    }
  }
}

/** Функции, где [Колонка] — значение этой строки, а не вся колонка. */
const isRowOnly = (name: string): boolean => !['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'].includes(name);
