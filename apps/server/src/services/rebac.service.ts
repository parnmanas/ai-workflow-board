import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RelationTuple } from '../entities/RelationTuple';
import { LogService } from './log.service';

@Injectable()
export class ReBACService {
  constructor(
    @InjectRepository(RelationTuple) private readonly tupleRepo: Repository<RelationTuple>,
    private readonly logService: LogService,
  ) {}

  // Grant a relation tuple. No-op if already exists (idempotent).
  async grant(
    subject: { type: string; id: string },
    relation: string,
    object: { type: string; id: string },
  ): Promise<void> {
    const existing = await this.tupleRepo.findOne({
      where: {
        subject_type: subject.type,
        subject_id: subject.id,
        relation,
        object_type: object.type,
        object_id: object.id,
      },
    });
    if (existing) return;

    const tuple = this.tupleRepo.create({
      subject_type: subject.type,
      subject_id: subject.id,
      relation,
      object_type: object.type,
      object_id: object.id,
    });
    await this.tupleRepo.save(tuple);
    this.logService.info('ReBAC', 'grant', { subject, relation, object });
  }

  // Revoke a relation tuple. No-op if not found.
  async revoke(
    subject: { type: string; id: string },
    relation: string,
    object: { type: string; id: string },
  ): Promise<void> {
    await this.tupleRepo.delete({
      subject_type: subject.type,
      subject_id: subject.id,
      relation,
      object_type: object.type,
      object_id: object.id,
    });
  }

  // Check if a specific relation tuple exists.
  async check(
    subject: { type: string; id: string },
    relation: string,
    object: { type: string; id: string },
  ): Promise<boolean> {
    const result = await this.tupleRepo.findOne({
      where: {
        subject_type: subject.type,
        subject_id: subject.id,
        relation,
        object_type: object.type,
        object_id: object.id,
      },
    });
    return !!result;
  }

  // List all object_ids of a given type that subject has the given relation to.
  async listObjects(
    subject: { type: string; id: string },
    relation: string,
    objectType: string,
  ): Promise<string[]> {
    const tuples = await this.tupleRepo.find({
      where: {
        subject_type: subject.type,
        subject_id: subject.id,
        relation,
        object_type: objectType,
      },
    });
    return tuples.map(t => t.object_id);
  }

  // List all subjects that have the given relation to the given object.
  async listSubjects(
    object: { type: string; id: string },
    relation: string,
  ): Promise<{ type: string; id: string }[]> {
    const tuples = await this.tupleRepo.find({
      where: {
        object_type: object.type,
        object_id: object.id,
        relation,
      },
    });
    return tuples.map(t => ({ type: t.subject_type, id: t.subject_id }));
  }

  // Convenience: union of object_ids across multiple relations (e.g. 'member' | 'owner').
  async listObjectsByMultipleRelations(
    subject: { type: string; id: string },
    relations: string[],
    objectType: string,
  ): Promise<string[]> {
    const results = await Promise.all(
      relations.map(rel => this.listObjects(subject, rel, objectType)),
    );
    // Deduplicate via Set
    return [...new Set(results.flat())];
  }
}
