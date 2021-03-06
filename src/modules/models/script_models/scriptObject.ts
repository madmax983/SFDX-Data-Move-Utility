/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */



import "reflect-metadata";
import "es6-shim";
import { Type } from "class-transformer";
import { Query } from 'soql-parser-js';
import { Common } from "../../components/common_components/common";
import { DATA_MEDIA_TYPE, OPERATION, CONSTANTS } from "../../components/common_components/statics";
import { RESOURCES } from "../../components/common_components/logger";
import { Sfdx } from "../../components/common_components/sfdx";
import {
    parseQuery,
    composeQuery,
    Field as SOQLField,
    getComposedField
} from 'soql-parser-js';
import { ScriptMockField, Script, SObjectDescribe, MigrationJobTask } from "..";
import SFieldDescribe from "./sfieldDescribe";
import { CommandInitializationError, OrgMetadataError } from "../common_models/errors";


/**
 * Parsed object 
 * from the script file 
 *
 * @export
 * @class ScriptObject
 */
export default class ScriptObject {

    // ------------- JSON --------------
    @Type(() => ScriptMockField)
    mockFields: ScriptMockField[] = new Array<ScriptMockField>();

    query: string = "";
    deleteQuery: string = "";
    operation: OPERATION = OPERATION.Readonly;
    externalId: string = CONSTANTS.DEFAULT_EXTERNAL_ID_FIELD_NAME;
    deleteOldData: boolean = false;
    updateWithMockData: boolean = false;
    mockCSVData: boolean = false;
    targetRecordsFilter: string = "";
    excluded: boolean = false;
    useCSVValuesMapping: boolean = false;
    allRecords: boolean = true;
    excludedFields: Array<string> = new Array<string>();



    // -----------------------------------
    script: Script;
    name: string = "";
    sourceSObjectDescribe: SObjectDescribe;
    targetSObjectDescribe: SObjectDescribe;
    originalExternalId: string = "";
    parsedQuery: Query;
    parsedDeleteQuery: Query;
    isExtraObject: boolean = false;
    processAllSource: boolean = false;
    processAllTarget: boolean = false;
    multiselectPattern: any;

    get task(): MigrationJobTask {
        return this.script.job.getTaskBySObjectName(this.name);
    }

    get externalIdSFieldDescribe(): SFieldDescribe {
        return this.isDescribed
            && this.sourceSObjectDescribe.fieldsMap.get(this.externalId);
    }

    get fieldsInQuery(): string[] {
        if (!this.parsedQuery) {
            return new Array<string>();
        }
        return this.parsedQuery.fields.map(x => (<SOQLField>x).field);
    }

    get fieldsInQueryMap(): Map<string, SFieldDescribe> {
        if (!this.isDescribed) {
            return new Map<string, SFieldDescribe>();
        }
        return Common.filterMapByArray(this.fieldsInQuery, this.sourceSObjectDescribe.fieldsMap, key => new SFieldDescribe({
            creatable: false,
            name: key,
            label: key,
            updateable: false,
            type: "dynamic"
        }), true);
    }

    get fieldsToUpdate(): string[] {
        if (!this.parsedQuery
            || !this.isDescribed
            || this.sourceSObjectDescribe.fieldsMap.size == 0
            || this.operation == OPERATION.Readonly) {
            return new Array<string>();
        }
        return this.parsedQuery.fields.map(x => {
            let name = (<SOQLField>x).field;
            let describe = this.sourceSObjectDescribe.fieldsMap.get(name)
                || this.targetSObjectDescribe && this.targetSObjectDescribe.fieldsMap && this.targetSObjectDescribe.fieldsMap.get(name);
            if (!describe || describe.readonly) {
                return null;
            }
            return (<SOQLField>x).field;
        }).filter(x => !!x);
    }

    get fieldsToUpdateMap(): Map<string, SFieldDescribe> {
        if (!this.sourceSObjectDescribe) {
            return new Map<string, SFieldDescribe>();
        }
        return Common.filterMapByArray(this.fieldsToUpdate, this.sourceSObjectDescribe.fieldsMap);
    }

    get hasRecordTypeIdField(): boolean {
        return this.fieldsInQuery.some(x => x == "RecordTypeId");
    }

    get strOperation(): string {
        return ScriptObject.getStrOperation(this.operation);
    }

    get isLimitedQuery(): boolean {
        return this.parsedQuery
            && (this.parsedQuery.limit > 0 || !!this.parsedQuery.where);
    }

    get isSpecialObject(): boolean {
        return CONSTANTS.SPECIAL_OBJECTS.indexOf(this.name) >= 0;
    }

    get isReadonlyObject(): boolean {
        return this.operation == OPERATION.Readonly || this.operation == OPERATION.Delete;
    }

    get hasComplexExternalId(): boolean {
        return Common.isComplexOr__rField(this.externalId);
    }

    get hasAutonumberExternalId(): boolean {
        let extIdField = this.externalIdSFieldDescribe;
        return extIdField.autoNumber || extIdField.name == "Id";
    }

    get hasComplexOriginalExternalId(): boolean {
        return Common.isComplexOr__rField(this.originalExternalId);
    }

    get isDescribed(): boolean {
        return !!this.sourceSObjectDescribe;
    }

    get isInitialized(): boolean {
        return !!this.script;
    }

    get parentLookupObjects(): ScriptObject[] {
        return Common.distinctArray([...this.fieldsInQueryMap.values()].map(x => {
            if (x.lookup) {
                return x.parentLookupObject;
            }
        }).filter(x => !!x), 'name');
    }

    get parentMasterDetailObjects(): ScriptObject[] {
        return Common.distinctArray([...this.fieldsInQueryMap.values()].map(x => {
            if (x.isMasterDetail) {
                return x.parentLookupObject;
            }
        }).filter(x => !!x), 'name');
    }

    get complexExternalId(): string {
        return Common.getComplexField(this.externalId);
    }

    get complexOriginalExternalId(): string {
        return Common.getComplexField(this.originalExternalId);
    }

    /**
     * This object has some parent relationships to other sobjects
     *
     * @readonly
     * @type {boolean}
     * @memberof ScriptObject
     */
    get hasParentLookupObjects(): boolean {
        return [...this.fieldsInQueryMap.values()].some(field => {
            return field.isSimpleReference;
        });
    }

    /**
     * This object has some child relationships to other sobjects
     *
     * @readonly
     * @type {boolean}
     * @memberof ScriptObject
     */
    get hasChildLookupObjects(): boolean {
        return [...this.fieldsInQueryMap.values()].some(field => {
            return field.child__rSFields.length > 0;
        });
    }

    get isObjectWithoutRelationships(): boolean {
        return !this.hasParentLookupObjects && !this.hasChildLookupObjects;
    }


    // ----------------------- Public methods -------------------------------------------    
    /**
     * Setup this object
     *
     * @param {Script} script
     * @memberof ScriptObject
     */
    setup(script: Script) {

        if (this.isInitialized) return;

        // Initialize object
        this.script = script;
        this.originalExternalId = this.externalId;

        // Fixes operation value
        this.operation = ScriptObject.getOperation(this.operation);

        // Always set explicit externalId to 'Id' on Insert operation
        if (this.operation == OPERATION.Insert) {
            this.externalId = "Id";
        }

        try {
            // Parse query string    
            this.parsedQuery = this._parseQuery(this.query);
        } catch (ex) {
            throw new CommandInitializationError(this.script.logger.getResourceString(RESOURCES.MalformedQuery, this.name, this.query, ex));
        }
        if (this.operation == OPERATION.Delete) {
            this.deleteOldData = true;
            this.parsedQuery.fields = [getComposedField("Id")];
        }
        // Add record Id field to the query
        if (!this.fieldsInQuery.some(x => x == "Id")) {
            this.parsedQuery.fields.push(getComposedField("Id"));
        }
        // Add external Id field to the query
        if (this.hasComplexExternalId) {
            this.parsedQuery.fields.push(getComposedField(this.complexExternalId));
        } else {
            this.parsedQuery.fields.push(getComposedField(this.externalId));
        }
        // Add original external id field to the query
        this.parsedQuery.fields.push(getComposedField(this.complexOriginalExternalId));
        // Add IsPersonAccount field
        if (this.script.isPersonAccountEnabled && (this.name == "Account" || this.name == "Contact")) {
            this.parsedQuery.fields.push(getComposedField("IsPersonAccount"));
        }
        // Make each field appear only once in the query
        this.parsedQuery.fields = Common.distinctArray(this.parsedQuery.fields, "field");


        // Update object
        this.query = composeQuery(this.parsedQuery);
        this.name = this.parsedQuery.sObject;
        this.script.objectsMap.set(this.name, this);

        // Parse delete query string
        if (this.deleteOldData) {
            try {
                if (this.deleteQuery) {
                    this.parsedDeleteQuery = parseQuery(this.deleteQuery);
                } else {
                    this.parsedDeleteQuery = parseQuery(this.query);
                }
                this.parsedDeleteQuery.fields = [getComposedField("Id")];
                if (this.script.isPersonAccountEnabled && this.name == "Contact") {
                    this.parsedDeleteQuery.where = Common.composeWhereClause(this.parsedDeleteQuery.where, "IsPersonAccount", "false", "=", "BOOLEAN", "AND");
                }
                this.deleteQuery = composeQuery(this.parsedDeleteQuery);
            } catch (ex) {
                throw new CommandInitializationError(this.script.logger.getResourceString(RESOURCES.MalformedDeleteQuery, this.name, this.deleteQuery, ex));
            }
        }
    }

    /**
     * Retrieves the object descriptions from the source and from the target org
     *
     * @returns {Promise<void>}
     * @memberof ScriptObject
     */
    async describeAsync(): Promise<void> {

        if (this.isDescribed) return;

        // Describe object in the source org
        if (!this.isDescribed) {

            if (this.script.sourceOrg.media == DATA_MEDIA_TYPE.Org) {

                let apisf = new Sfdx(this.script.sourceOrg);
                this.script.logger.infoNormal(RESOURCES.gettingMetadataForSObject, this.name, this.script.logger.getResourceString(RESOURCES.source));
                try {
                    // Retrieve sobject metadata
                    this.sourceSObjectDescribe = await apisf.describeSObjectAsync(this.name);
                    [...this.sourceSObjectDescribe.fieldsMap.values()].forEach(x => x.scriptObject = this);

                    if (this.script.targetOrg.media == DATA_MEDIA_TYPE.File) {
                        this.targetSObjectDescribe = this.sourceSObjectDescribe;
                    }

                    // Add fields by the multiselect keywords + filter query
                    this._addOrRemmoveFields(this.sourceSObjectDescribe);

                    // Check fields existance
                    this._validateFields(this.sourceSObjectDescribe, true);

                } catch (ex) {
                    if (ex instanceof CommandInitializationError) {
                        throw ex;
                    }
                    throw new OrgMetadataError(this.script.logger.getResourceString(RESOURCES.objectSourceDoesNotExist, this.name));
                }

            }

            if (this.script.targetOrg.media == DATA_MEDIA_TYPE.Org) {

                // Describe object in the target org        
                let apisf = new Sfdx(this.script.targetOrg);
                this.script.logger.infoNormal(RESOURCES.gettingMetadataForSObject, this.name, this.script.logger.getResourceString(RESOURCES.target));
                try {
                    // Retrieve sobject metadata
                    this.targetSObjectDescribe = await apisf.describeSObjectAsync(this.name);
                    [...this.targetSObjectDescribe.fieldsMap.values()].forEach(x => x.scriptObject = this);

                    if (this.script.sourceOrg.media == DATA_MEDIA_TYPE.File) {
                        this.sourceSObjectDescribe = this.targetSObjectDescribe;

                        // Add fields by the multiselect keywords + filter query
                        this._addOrRemmoveFields(this.targetSObjectDescribe);
                    }

                    // Check fields existance
                    this._validateFields(this.targetSObjectDescribe, false);

                } catch (ex) {
                    if (ex instanceof CommandInitializationError) {
                        throw ex;
                    }
                    throw new OrgMetadataError(this.script.logger.getResourceString(RESOURCES.objectTargetDoesNotExist, this.name));
                }
            }
        }
    }

    /**
     * Converts numeric enum value into string
     *
     * @static
     * @param {OPERATION} operation
     * @returns
     * @memberof ScriptObject
     */
    public static getStrOperation(operation: OPERATION) {
        if ((typeof operation != "string") == true) {
            return OPERATION[operation].toString();
        }
        return operation.toString();
    }

    /**
     * Converts string enum value into numeric
     *
     * @static
     * @param {OPERATION} operation
     * @returns
     * @memberof ScriptObject
     */
    public static getOperation(operation: OPERATION) {
        if ((typeof operation == "string") == true) {
            return OPERATION[operation.toString()];
        }
        return operation;
    }

    // ----------------------- Private members -------------------------------------------
    private _addOrRemmoveFields(describe: SObjectDescribe) {
        if (this.multiselectPattern) {
            let fieldsInOriginalQuery = [].concat(this.fieldsInQuery);
            let pattern = this.multiselectPattern;
            [...describe.fieldsMap.values()].forEach(fieldDescribe => {
                if ((___compare(pattern.all != "undefined", pattern.all == true)
                    || !Object.keys(pattern).some(prop => ___compare(fieldDescribe[prop], pattern[prop], true)))
                    && ___compare(fieldsInOriginalQuery.indexOf(fieldDescribe.name) < 0, true)) {
                    if (!(fieldDescribe.lookup && CONSTANTS.OBJECTS_NOT_TO_USE_IN_QUERY_MULTISELECT.indexOf(fieldDescribe.referencedObjectType) >= 0)) {
                        this.parsedQuery.fields.push(getComposedField(fieldDescribe.name));
                    }
                }
            });
        }
        this.parsedQuery.fields = this.parsedQuery.fields.filter((field: SOQLField) =>
            this.excludedFields.indexOf(field.field) < 0
        );
        this.query = composeQuery(this.parsedQuery);

        // ---------------------- Internal functions --------------------------- //        
        function ___compare(fieldDescribeProperty: any, patternProperty: any, negative: boolean = false): boolean {
            if (!negative)
                return fieldDescribeProperty == patternProperty || typeof patternProperty == "undefined";
            else
                return fieldDescribeProperty != patternProperty && typeof fieldDescribeProperty != "undefined";
        }
    }

    private _validateFields(describe: SObjectDescribe, isSource: boolean) {

        if (this.fieldsInQuery.length == 0) {
            throw new CommandInitializationError(this.script.logger.getResourceString(RESOURCES.missingFieldsToProcess, this.name));
        }

        if (!this.isExtraObject && !this.isSpecialObject) {

            let fieldsInQuery = [].concat(this.fieldsInQuery);

            fieldsInQuery.forEach(x => {
                if (!Common.isComplexOr__rField(x) && !describe.fieldsMap.has(x)) {

                    if (x.name == this.externalId) {
                        // Missing externalId field. 
                        throw new OrgMetadataError(this.script.logger.getResourceString(RESOURCES.noExternalKey, this.name, this.strOperation));
                    }

                    // Field in the query is missing in the org metadata. Warn user.
                    if (isSource)
                        this.script.logger.warn(RESOURCES.fieldSourceDoesNtoExist, this.name, x);
                    else
                        this.script.logger.warn(RESOURCES.fieldTargetDoesNtoExist, this.name, x);

                    // Remove missing field from the query                    
                    Common.removeBy(this.parsedQuery.fields, "field", x);
                }
            });
        }
    }

    private _parseQuery(query: string): Query {
        let self = this;
        let parsedQuery = parseQuery(query);
        let fields = [].concat(parsedQuery.fields);
        parsedQuery.fields = [getComposedField("Id")];
        fields.forEach(field => {
            let fieldName = ((<SOQLField>field).field).toLowerCase();
            if (fieldName == "all") {
                ___set("all_true");
            } else if (CONSTANTS.MULTISELECT_SOQL_KEYWORDS.indexOf(fieldName) >= 0) {
                ___set(fieldName);
            } else if (fieldName != "id") {
                parsedQuery.fields.push(getComposedField((<SOQLField>field).field));
            }
        });
        this.query = composeQuery(parsedQuery);
        return parsedQuery;

        // ---------------------- Internal functions --------------------------- //
        function ___set(fieldName: string) {
            self.multiselectPattern = self.multiselectPattern || {};
            let parts = fieldName.split('_');
            self.multiselectPattern[parts[0]] = parts[1] == "true";
        }
    }


}
