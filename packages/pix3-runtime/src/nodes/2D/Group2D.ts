import { Vector2 } from 'three';

import { Node2D, type Node2DProps } from '../Node2D';
import type { PropertySchema } from '../../fw/property-schema';

export interface Group2DProps extends Omit<Node2DProps, 'type'> {
  width?: number;
  height?: number;
}

export class Group2D extends Node2D {
  private _width: number;
  private _height: number;

  constructor(props: Group2DProps, nodeType: string = 'Group2D') {
    super(props, nodeType);

    this._width = Number.isFinite(props.width) ? Math.max(0, props.width ?? 0) : 100;
    this._height = Number.isFinite(props.height) ? Math.max(0, props.height ?? 0) : 100;
    this.isContainer = true;
  }

  get width(): number {
    return this._width;
  }

  set width(value: number) {
    const nextValue = Number.isFinite(value) ? Math.max(0, value) : this._width;
    if (this._width === nextValue) {
      return;
    }

    this._width = nextValue;
    this.reflowAnchoredChildren();
  }

  get height(): number {
    return this._height;
  }

  set height(value: number) {
    const nextValue = Number.isFinite(value) ? Math.max(0, value) : this._height;
    if (this._height === nextValue) {
      return;
    }

    this._height = nextValue;
    this.reflowAnchoredChildren();
  }

  getSize(): Vector2 {
    return new Vector2(this._width, this._height);
  }

  setSize(width: number, height: number): void {
    const nextWidth = Number.isFinite(width) ? Math.max(0, width) : this._width;
    const nextHeight = Number.isFinite(height) ? Math.max(0, height) : this._height;
    const changed = this._width !== nextWidth || this._height !== nextHeight;

    this._width = nextWidth;
    this._height = nextHeight;

    if (changed) {
      this.reflowAnchoredChildren();
    }
  }

  static getPropertySchema(): PropertySchema {
    const baseSchema = Node2D.getPropertySchema();

    return {
      nodeType: 'Group2D',
      extends: 'Node2D',
      properties: [
        ...baseSchema.properties,
        {
          name: 'width',
          type: 'number',
          ui: {
            label: 'Width',
            group: 'Size',
            step: 1,
            precision: 0,
            min: 0,
          },
          getValue: (node: unknown) => (node as Group2D).width,
          setValue: (node: unknown, value: unknown) => {
            (node as Group2D).width = Number(value);
          },
        },
        {
          name: 'height',
          type: 'number',
          ui: {
            label: 'Height',
            group: 'Size',
            step: 1,
            precision: 0,
            min: 0,
          },
          getValue: (node: unknown) => (node as Group2D).height,
          setValue: (node: unknown, value: unknown) => {
            (node as Group2D).height = Number(value);
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Size: {
          label: 'Size',
          description: 'Group dimensions',
          expanded: true,
        },
      },
    };
  }
}
