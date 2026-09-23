import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { GripVertical } from "lucide-react";
import { motion } from "motion/react";

import { Button } from "@/components/ui/button";
import type { Scene } from "@/lib/scene";

/**
 * Layers list (S7-T22) — the Capas panel's sortable overlay rows.
 *
 * Z-ORDER CONTRACT: row order IS `scene.overlays` array order, which is the
 * sidecar's paint order (later index painted on top — see
 * _paint_scene_overlays in bridge/lcd_bridge.py) and Konva's draw order
 * (later children on top). The list renders rows in ARRAY order: first row
 * = painted first = behind; last row = in front.
 *
 * GESTURE CONTRACT: a drag NEVER commits mid-flight — `onReorder` fires
 * exactly once from `onDragEnd`, so SceneEditor's store commit records
 * exactly ONE history entry and the [scene] effect arms exactly ONE
 * debounced preview push. Positional ids (String(index)) are safe because
 * the array is untouched until the drop.
 *
 * A11Y: the drag handle carries dnd-kit's keyboard sensor (Space grabs,
 * arrows move, Space drops, Escape cancels) plus its aria attributes and
 * screen-reader instructions; the `Overlay N` row button keeps its OWN job —
 * selection — so the Capas list stays fully keyboard-operable independent
 * of the Konva canvas. No @dnd-kit/utilities import: that package is not a
 * declared dependency, so the transform string is built inline.
 *
 * MOTION: rows fade/slide in on mount at the same 150 ms the S7-T19 panel
 * swap uses. Deliberately NO `layout` animation: dnd-kit drives the row
 * transform during a drag, and a second transform owner would fight it.
 */
interface LayersListProps {
  overlays: Scene["overlays"];
  /** SceneEditor's safeIndex (-1 = nothing selected). */
  selected: number;
  onSelect: (index: number) => void;
  /** Completed drag: array indices in the CURRENT (pre-drop) order. */
  onReorder: (from: number, to: number) => void;
}

interface LayerRowProps {
  id: string;
  index: number;
  selected: boolean;
  onSelect: (index: number) => void;
}

function LayerRow({ id, index, selected, onSelect }: LayerRowProps) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const label = `Overlay ${index + 1}`;

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: transform
          ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
          : undefined,
        transition,
        zIndex: isDragging ? 1 : undefined,
      }}
      className="flex items-center gap-2"
    >
      {/* Mount-only fade (150 ms — same duration as the panel swap). */}
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
        className="min-w-0 flex-1"
      >
        <Button
          type="button"
          size="sm"
          variant={selected ? "default" : "outline"}
          aria-pressed={selected}
          onClick={() => onSelect(index)}
        >
          {label}
        </Button>
      </motion.div>
      {/* Drag handle: dnd-kit activator (pointer + keyboard sensor). */}
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${label}`}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <GripVertical className="h-4 w-4" aria-hidden="true" />
      </button>
    </li>
  );
}

// Sensor options live at MODULE scope on purpose: inline option literals
// would be a new object identity on every render, and sensor configuration
// is keyed on that identity — reconfiguring mid-drag orphans the active
// sensor instance so its native move/end listeners go dead (observed in
// jsdom: activation fired, then no onDragMove/onDragEnd ever followed).
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 5 } };
const KEYBOARD_SENSOR_OPTIONS = {
  coordinateGetter: sortableKeyboardCoordinates,
};

export default function LayersList({
  overlays,
  selected,
  onSelect,
  onReorder,
}: LayersListProps) {
  // distance: 5 keeps a plain click on the handle from starting a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS)
  );

  const items = overlays.map((_, index) => String(index));

  const handleDragEnd = ({ active, over }: DragEndEvent): void => {
    if (!over || active.id === over.id) return;
    const from = Number(active.id);
    const to = Number(over.id);
    if (!Number.isInteger(from) || !Number.isInteger(to)) return;
    onReorder(from, to); // the ONE commit of this gesture
  };

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Text overlays</p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={items} strategy={verticalListSortingStrategy}>
          <ul aria-label="Text overlay order" className="space-y-1">
            {overlays.map((_, index) => (
              <LayerRow
                key={`overlay-row-${index}`}
                id={String(index)}
                index={index}
                selected={selected === index}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <p className="text-xs text-muted-foreground">
        Rows are painted bottom to top: later rows render in front. Focus a
        reorder handle and press Space to drag with the keyboard.
      </p>
    </div>
  );
}
