import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { BulkOperationBuilder } from '@/core/BulkOperation';
import {
  Transform2DCompleteOperation,
  type Transform2DCompleteParams,
} from '@/features/properties/Transform2DCompleteOperation';

export interface Transform2DBatchParams {
  plans: Transform2DCompleteParams[];
  label: string;
}

/**
 * Commit a set of 2D transform changes (multiple nodes — e.g. a resized Group2D plus its
 * proportionally-scaled descendants, or a multi-node drag) as a SINGLE undoable step. Each plan runs
 * through {@link Transform2DCompleteOperation}; the commits are composed with
 * {@link BulkOperationBuilder} (undo replays in reverse). Order the plans so a container precedes its
 * descendants — the container's anchor reflow then runs before the explicit child plans overwrite.
 */
export class Transform2DBatchOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.transform2d-batch',
    title: 'Transform 2D Objects',
    description: 'Apply and undo a batch of 2D transforms as one history entry',
    tags: ['property', 'transform', '2d'],
  };

  constructor(private readonly params: Transform2DBatchParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const bulk = new BulkOperationBuilder();
    for (const plan of this.params.plans) {
      const result = await new Transform2DCompleteOperation(plan).perform(context);
      if (result.didMutate && result.commit) {
        bulk.add(result.commit);
      }
    }

    if (bulk.isEmpty()) {
      return { didMutate: false };
    }

    return {
      didMutate: true,
      commit: bulk.build(this.params.label),
    };
  }
}
