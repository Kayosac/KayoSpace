import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addProject,
  boardProject,
  boardProjects,
  isServiceDoc,
  listProjects,
  removeProject,
  renameProject,
  setBoardProject,
  WORKSPACE_ID,
  DELETED_BOARD_KEEP_MS,
  deletedBoards,
  isBoardDeleted,
  markBoardDeleted,
  markBoardPurged,
  restorableBoards,
  restoreDeletedBoard,
} from './workspace';

describe('проекты', () => {
  it('создание по порядку, переименование, доски в проектах', () => {
    const doc = new Y.Doc();
    const a = addProject(doc, 'Работа');
    const b = addProject(doc, '  Дом  ');
    expect(listProjects(doc).map((p) => p.name)).toEqual(['Работа', 'Дом']);
    renameProject(doc, a, 'Kayospace');
    expect(listProjects(doc)[0]!.name).toBe('Kayospace');
    setBoardProject(doc, 'plan', a);
    setBoardProject(doc, 'shop', b);
    expect(boardProject(doc, 'plan')).toBe(a);
    expect(boardProject(doc, 'none')).toBeNull();
    setBoardProject(doc, 'plan', null);
    expect(boardProject(doc, 'plan')).toBeNull();
    expect([...boardProjects(doc).keys()]).toEqual(['shop']);
  });

  it('удаление проекта оставляет доски — без проекта', () => {
    const doc = new Y.Doc();
    const a = addProject(doc, 'Временный');
    setBoardProject(doc, 'x', a);
    removeProject(doc, a);
    expect(listProjects(doc)).toEqual([]);
    expect(boardProject(doc, 'x')).toBeNull();
  });

  it('проекты с двух устройств сливаются', () => {
    const one = new Y.Doc();
    const two = new Y.Doc();
    addProject(one, 'С мака');
    addProject(two, 'С планшета');
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two));
    expect(
      listProjects(one)
        .map((p) => p.name)
        .sort(),
    ).toEqual(['С мака', 'С планшета']);
    expect(listProjects(two).map((p) => p.id)).toEqual(listProjects(one).map((p) => p.id));
  });

  it('служебные документы — не доски', () => {
    expect(isServiceDoc(WORKSPACE_ID)).toBe(true);
    expect(isServiceDoc('plan')).toBe(false);
  });
});

describe('удалённые доски', () => {
  it('отметка, возврат и стирание', () => {
    const doc = new Y.Doc();
    markBoardDeleted(doc, 'plan-1', 'План', undefined, 1000);
    expect(isBoardDeleted(doc, 'plan-1')).toBe(true);
    expect(restorableBoards(doc, 2000)).toEqual([{ id: 'plan-1', at: 1000, name: 'План' }]);
    expect(restoreDeletedBoard(doc, 'plan-1')).toBe(true);
    expect(isBoardDeleted(doc, 'plan-1')).toBe(false);
    expect(restoreDeletedBoard(doc, 'plan-1')).toBe(false);

    markBoardDeleted(doc, 'old', null, undefined, 1000);
    markBoardPurged(doc, 'old');
    expect(deletedBoards(doc).get('old')?.purged).toBe(true);
    expect(restoreDeletedBoard(doc, 'old')).toBe(false);
    expect(restorableBoards(doc, 2000)).toEqual([]);
  });

  it('через 7 дней доску вернуть нельзя; служебные документы не удаляются', () => {
    const doc = new Y.Doc();
    markBoardDeleted(doc, 'a', null, undefined, 0);
    expect(restorableBoards(doc, DELETED_BOARD_KEEP_MS + 1)).toEqual([]);
    markBoardDeleted(doc, WORKSPACE_ID, null);
    expect(isBoardDeleted(doc, WORKSPACE_ID)).toBe(false);
  });
});
