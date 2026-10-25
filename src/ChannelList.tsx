import { memo, useState, type MouseEvent } from 'react';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Channel } from '../shared/types.ts';

export interface RowData {
  id: number;
  name: string;
  index: number;
  newNumber: number | null;
  oldNumber: number | null;
  numberSource: Channel['numberSource'];
  scrambled?: boolean;
  /** Çift kanal temizliğinde TV'den silinecek olarak işaretli. */
  removing?: boolean;
}

interface Props {
  rows: RowData[];
  selected: Set<number>;
  query: string;
  disabled: boolean;
  onRowClick: (id: number, e: MouseEvent) => void;
  onToggle: (id: number, e: MouseEvent) => void;
  onDragEnd: (activeId: number, overId: number) => void;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLocaleLowerCase('tr');
  if (!q) return <>{text}</>;
  const i = text.toLocaleLowerCase('tr').indexOf(q);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function DeltaBadge({ oldNumber, newNumber }: { oldNumber: number | null; newNumber: number | null }) {
  if (oldNumber === null || newNumber === null) return <span className="delta unknown">?</span>;
  if (oldNumber === newNumber) return <span className="delta same">—</span>;
  const up = newNumber < oldNumber;
  return (
    <span className={`delta ${up ? 'up' : 'down'}`} title={`Eski numara ${oldNumber}`}>
      {up ? '▲' : '▼'} {Math.abs(oldNumber - newNumber)}
    </span>
  );
}

interface RowProps {
  row: RowData;
  isSelected: boolean;
  ghost: boolean;
  query: string;
  disabled: boolean;
  onRowClick: Props['onRowClick'];
  onToggle: Props['onToggle'];
}

const Row = memo(function Row({ row, isSelected, ghost, query, disabled, onRowClick, onToggle }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id, disabled });
  const changed = row.oldNumber !== row.newNumber;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`row${isSelected ? ' selected' : ''}${changed ? ' changed' : ''}${row.removing ? ' removing' : ''}${isDragging || ghost ? ' ghost' : ''}`}
      onClick={(e) => onRowClick(row.id, e)}
      role="row"
      aria-selected={isSelected}
    >
      <label className="check" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => undefined}
          onClick={(e) => onToggle(row.id, e)}
          aria-label={`${row.name} seç`}
        />
      </label>
      <button className="handle" {...attributes} {...listeners} disabled={disabled} aria-label="Sürükle" onClick={(e) => e.stopPropagation()}>
        <svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true">
          {[3, 8, 13].map((y) => (
            <g key={y}>
              <circle cx="2.5" cy={y} r="1.4" />
              <circle cx="7.5" cy={y} r="1.4" />
            </g>
          ))}
        </svg>
      </button>
      <span className="num">{row.newNumber ?? '—'}</span>
      <span className="name">
        <Highlight text={row.name} query={query} />
        {row.removing && <span className="tag del" title="Çift kanal: TV'den silinecek">silinecek</span>}
        {row.scrambled && (
          <span className="tag lock" title="TV'de şifreli (kilit ikonlu) kanal">
            <svg viewBox="0 0 12 14" width="9" height="10" aria-hidden="true">
              <rect x="1" y="6" width="10" height="7.5" rx="1.5" fill="currentColor" />
              <path d="M3.5 6V4.2a2.5 2.5 0 0 1 5 0V6" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
            şifreli
          </span>
        )}
        {row.numberSource === 'inferred' && <span className="tag" title="Numara, adındaki rakamlar nedeniyle eleme yöntemiyle bulundu">tahmini no</span>}
        {row.numberSource === 'unknown' && <span className="tag warn">numara yok</span>}
      </span>
      <span className="old">{changed ? `eski ${row.oldNumber ?? '?'}` : ''}</span>
      <DeltaBadge oldNumber={row.oldNumber} newNumber={row.newNumber} />
    </div>
  );
});

export function ChannelList({ rows, selected, query, disabled, onRowClick, onToggle, onDragEnd }: Props) {
  const [activeId, setActiveId] = useState<number | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const active = rows.find((r) => r.id === activeId);
  const groupDrag = activeId !== null && selected.has(activeId) && selected.size > 1;

  const handleStart = (e: DragStartEvent) => setActiveId(Number(e.active.id));
  const handleEnd = (e: DragEndEvent) => {
    setActiveId(null);
    if (e.over && e.active.id !== e.over.id) onDragEnd(Number(e.active.id), Number(e.over.id));
  };

  if (!rows.length) return <div className="empty">Eşleşen kanal yok.</div>;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleStart} onDragEnd={handleEnd} onDragCancel={() => setActiveId(null)}>
      <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
        <div className="rows" role="grid" aria-label="Kanal listesi">
          {rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              isSelected={selected.has(row.id)}
              ghost={groupDrag && selected.has(row.id) && row.id !== activeId}
              query={query}
              disabled={disabled}
              onRowClick={onRowClick}
              onToggle={onToggle}
            />
          ))}
        </div>
      </SortableContext>
      <DragOverlay>
        {active && (
          <div className="row overlay">
            <span className="num">{active.newNumber}</span>
            <span className="name">{active.name}</span>
            {groupDrag && <span className="count">+{selected.size - 1} kanal</span>}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
