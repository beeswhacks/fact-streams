/* eslint-disable @typescript-eslint/ban-ts-comment */
import { Db, Document, MongoError, ObjectId } from 'mongodb';

import { FactReducer, FactStore, NEW, PersistentView, UnknownFact } from './types';

export interface CreateFactStoreOptions {
  name: string;
}

export async function createFactStore<F extends UnknownFact>(mongoDatabase: Db, options: CreateFactStoreOptions): Promise<FactStore<F>> {
  const {
    name: factStoreName,
  } = options;

  const onBeforeAppendListeners: ((fact: F) => Promise<F>)[] = [];
  const onAppendListeners: ((fact: F) => Promise<void>)[] = [];

  // Ensure the collection exists and it has the required index
  try {
    await mongoDatabase.createCollection(factStoreName);
  } catch (error) {
    if (error instanceof MongoError && error.message.startsWith('Collection already exists')) {
      // No-op: the collection already exists
    } else {
      throw error;
    }
  }
  await mongoDatabase.collection(factStoreName).createIndex({ streamId: 1, sequence: 1 }, { name: 'streamId_sequence', unique: true });

  async function append(fact: F): Promise<F> {
    // Find the latest sequence number for this stream
    let newStreamId;
    let newSequence;

    if (NEW.equals(fact.streamId)) {
      newStreamId = new ObjectId();
      newSequence = 1;
    } else {
      const lastFactInDb = await mongoDatabase
        .collection<F>(factStoreName)
        //TODO: why does this type fail?
        // @ts-ignore
        .find({ streamId: fact.streamId })
        .sort({ sequence: -1 })
        .limit(1)
        .toArray();

      newStreamId = fact.streamId;
      newSequence = lastFactInDb.length === 0
        ? 1
        : (lastFactInDb[0]?.sequence || 0) + 1;
    }

    // Create the Fact that will saved
    let factToSave: F = {
      ...fact,
      streamId: newStreamId,
      sequence: newSequence,
      time: new Date(),
    };

    // Run all the validation functions, which might change the fact to be saved
    for await (const callback of onBeforeAppendListeners) {
      factToSave = await callback(factToSave);
    }

    // Optimistic insert
    // TODO: wrap the MongoError with a FactStreams error on duplicates, otherwise throw as is
    // TODO: if duplicate sequence, then try again (3 times?)
    await mongoDatabase.collection(factStoreName).insertOne(factToSave);

    // Call all the listeners
    for await (const callback of onAppendListeners) {
      await callback(factToSave);
    }

    return factToSave;
  }

  function onAppend(callback: (fact: F) => Promise<void>) {
    onAppendListeners.push(callback);
  }

  function onBeforeAppend(callback: (fact: F) => Promise<F>) {
    onBeforeAppendListeners.push(callback);
  }

  async function* find(streamId: ObjectId | string) {
    const cursor = await mongoDatabase
      .collection<F>(factStoreName)
      //TODO: why does this type fail?
      // @ts-ignore
      .find({ streamId: new ObjectId(streamId) });

    yield* cursor;
  }

  async function* findAll() {
    const cursor = await mongoDatabase
      .collection<F>(factStoreName)
      .find();

    yield* cursor;
  }

  function createTransientView<S>(reducer: FactReducer<S, F>, initialState: S | null = null) {
    return async function(streamId: ObjectId | string) {
      const cursor = await find(streamId);
      let state: S | null = initialState;
      for await (const fact of cursor) {
        // @ts-ignore
        state = reducer(state, fact);
      }
      return state;
    }
  }

  function createPersistentView<S extends Document>(view: PersistentView<S, F>) {
    const {
      collectionName,
      idField,
      initialState = null,
      reducer,
    } = view;

    onAppendListeners.push(async (latestFact) => {
      const cursor = await find(latestFact.streamId);
      let state: S | null = initialState;
      for await (const fact of cursor) {
        // @ts-ignore
        state = reducer(state, fact);
      }

      if (state === null) {
        await mongoDatabase.collection(collectionName).deleteOne({ [idField]: latestFact.streamId });
      } else {
        await mongoDatabase.collection(collectionName).replaceOne(
          { [idField]: latestFact.streamId },
          state,
          { upsert: true },
        );
      }
    });

    return mongoDatabase.collection<S>(collectionName);
  }

  return {
    append,
    onAppend,
    onBeforeAppend,
    find,
    findAll,
    createTransientView,
    createPersistentView,
    mongoDatabase,
  };
}
