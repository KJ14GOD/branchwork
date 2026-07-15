export type CanvasItemSummary = {
  id: string;
  type: string;
};

export type CanvasState = {
  itemCount: number;
  selectedItems: CanvasItemSummary[];
};
