/*!
 * ${copyright}
 */

sap.ui.define(['sap/ui/model/ClientContextBinding', 'sap/ui/model/json/JSONListBinding',
		'sap/ui/model/json/JSONModel', 'sap/ui/model/json/JSONPropertyBinding',
		'sap/ui/model/json/JSONTreeBinding', 'sap/ui/model/MetaModel'],
	function(ClientContextBinding, JSONListBinding, JSONModel, JSONPropertyBinding,
			JSONTreeBinding, MetaModel) {
	"use strict";

	/*global Promise */

	/**
	 * Constructor for a new ODataMetaModel.
	 *
	 * @class Model implementation for OData meta models, which are read-only models. No events
	 * ({@link sap.ui.model.Model#event:parseError parseError},
	 * {@link sap.ui.model.Model#event:requestCompleted requestCompleted},
	 * {@link sap.ui.model.Model#event:requestFailed requestFailed},
	 * {@link sap.ui.model.Model#event:requestSent requestSent}) are fired!
	 * For asynchronous loading use {@link #loaded loaded} instead, which is based on promises.
	 *
	 * This implementation offers a unified access to both OData v2 metadata and v4 annotations.
	 * It uses the existing {@link sap.ui.model.odata.ODataMetadata} as a foundation and merges v4
	 * annotations from the existing {@link sap.ui.model.odata.ODataAnnotations} directly into the
	 * corresponding entity or property.
	 *
	 * @extends sap.ui.model.MetaModel
	 *
	 * @author SAP SE
	 * @version ${version}
	 *
	 * @constructor
	 * @alias sap.ui.model.odata.ODataMetaModel
	 * @param {sap.ui.model.odata.ODataMetadata} oMetadata
	 *   the OData model's metadata object
	 * @param {sap.ui.model.odata.ODataAnnotations} oAnnotations
	 *   the OData model's annotations object
	 * @public
	 */
	var ODataMetaModel = MetaModel.extend("sap.ui.model.odata.ODataMetaModel",
			/** @lends sap.ui.model.odata.ODataMetaModel.prototype */ {

			constructor : function(oMetadata, oAnnotations) {
				MetaModel.apply(this); // no arguments to pass!
				this.sDefaultBindingMode = sap.ui.model.BindingMode.OneTime;
				this.mSupportedBindingModes = {"OneTime" : true};
				this.oModel = new JSONModel();
				this.oModel.setDefaultBindingMode(this.sDefaultBindingMode);
				this.oLoadedPromise = load(this.oModel, oMetadata, oAnnotations);
			},

			metadata : {
				publicMethods : ["loaded"]
			}
		});

	/*
	 * Returns the index of the object inside the given array, where the property with the given
	 * name has the given expected value.
	 *
	 * @param {object[]} aArray
	 *   some array
	 * @param {any} vExpectedPropertyValue
	 *   expected value of the property with given name
	 * @param {string} [sPropertyName="name"]
	 *   some property name
	 * @returns {number}
	 *   the index of the object found or <code>-1</code> if no such object is found
	 */
	function findIndex(aArray, vExpectedPropertyValue, sPropertyName) {
		var iIndex = -1;

		sPropertyName = sPropertyName || "name";
		jQuery.each(aArray || [], function (i, oObject) {
			if (oObject[sPropertyName] === vExpectedPropertyValue) {
				iIndex = i;
				return false; // break
			}
		});

		return iIndex;
	}

	/*
	 * Returns the object inside the given array, where the property with the given name has the
	 * given expected value.
	 *
	 * @param {object[]} aArray
	 *   some array
	 * @param {any} vExpectedPropertyValue
	 *   expected value of the property with given name
	 * @param {string} [sPropertyName="name"]
	 *   some property name
	 * @returns {object}
	 *   the object found or <code>null</code> if no such object is found
	 */
	function findObject(aArray, vExpectedPropertyValue, sPropertyName) {
		var iIndex = findIndex(aArray, vExpectedPropertyValue, sPropertyName);

		return iIndex < 0 ? null : aArray[iIndex];
	}

	/*
	 * Returns the thing with the given qualified name from the given model's array (within a
	 * schema) of given name; either as a path or as an object, as indicated.
	 *
	 * @param {sap.ui.model.Model} oModel
	 *   any model
	 * @param {string} sArrayName
	 *  name of array within schema which will be searched
	 * @param {string} sQualifiedName
	 *   a qualified name, e.g. "ACME.Foo"
	 * @param {boolean} [bAsPath=false]
	 *   determines whether the thing is returned as a path or as an object
	 * @returns {object|string}
	 *   (the path to) the thing with the given qualified name; <code>undefined</code> (for a path)
	 *   or <code>null</code> (for an object) if no such thing is found
	 */
	function getPathOrObject(oModel, sArrayName, sQualifiedName, bAsPath) {
		var vResult = bAsPath ? undefined : null,
			aParts = (sQualifiedName || "").split("."),
			sNamespace = aParts[0],
			sName = aParts[1];

		jQuery.each(oModel.getObject("/dataServices/schema") || [], function (i, oSchema) {
			if (oSchema.namespace === sNamespace) {
				jQuery.each(oSchema[sArrayName] || [], function (j, oThing) {
					if (oThing.name === sName) {
						vResult = bAsPath
							? "/dataServices/schema/" + i + "/" + sArrayName + "/" + j
							: oThing;
						return false; // break
					}
				});
				return false; // break
			}
		});

		return vResult;
	}

	/*
	 * @param {sap.ui.model.json.JSONModel} oModel
	 * @param {sap.ui.model.odata.ODataMetadata} oMetadata
	 * @param {sap.ui.model.odata.ODataAnnotations} oAnnotations
	 * @returns {Promise}
	 */
	function load(oModel, oMetadata, oAnnotations) {
		/*
		 * Lift all extensions from the <a href="http://www.sap.com/Protocols/SAPData">
		 * SAP Annotations for OData Version 2.0</a> namespace up as attributes with "sap:" prefix.
		 *
		 * @param {object} o
		 *   any object
		 */
		function liftSAPData(o) {
			jQuery.each(o.extensions || [], function (i, oExtension) {
				if (oExtension.namespace === "http://www.sap.com/Protocols/SAPData") {
					o["sap:" + oExtension.name] = oExtension.value;
				}
			});
		}

		/*
		 * Calls the given success handler as soon as the given object is "loaded".
		 * Calls the given error handler as soon as the given object is "failed".
		 *
		 * @param {object} o
		 * @param {function(void)} fnSuccess
		 * @param {function(Error)} fnError
		 */
		function loaded(o, fnSuccess, fnError) {
			if (!o || o.isLoaded()) {
				fnSuccess();
			} else if (o.isFailed()) {
				fnError(new Error("Error loading meta model"));
			} else {
				o.attachLoaded(fnSuccess);
				o.attachFailed(function (oEvent) {
					fnError(new Error("Error loading meta model: "
						+ oEvent.getParameter("message")));
				});
			}
		}

		/*
		 * Merges the given annotation data into the given meta data and lifts SAPData extensions.
		 * @param {object} oAnnotations
		 *   annotations "JSON"
		 * @param {object} oData
		 *   meta data "JSON"
		 */
		function merge(oAnnotations, oData) {
			jQuery.each(oData.dataServices.schema || [], function (i, oSchema) {
				liftSAPData(oSchema);
				jQuery.each(oSchema.entityType || [], function (j, oEntity) {
					var sEntityName = oSchema.namespace + "." + oEntity.name,
						mPropertyAnnotations = oAnnotations.propertyAnnotations
							&& oAnnotations.propertyAnnotations[sEntityName] || {};

					liftSAPData(oEntity);
					jQuery.extend(oEntity, oAnnotations[sEntityName]);

					jQuery.each(oEntity.property || [], function (k, oProperty) {
						liftSAPData(oProperty);
						jQuery.extend(oProperty, mPropertyAnnotations[oProperty.name]);
					});
				});
			});
		}

		return new Promise(function (fnResolve, fnReject) {
			loaded(oMetadata, function () {
				loaded(oAnnotations, function () {
					try {
						var oData = JSON.parse(JSON.stringify(oMetadata.getServiceMetadata()));
						merge(oAnnotations ? oAnnotations.getAnnotationsData() : {}, oData);
						oModel.setData(oData);
						fnResolve();
					} catch (ex) {
						fnReject(ex);
					}
				}, fnReject);
			}, fnReject);
		});
	}

	ODataMetaModel.prototype._getObject = function () {
		return this.oModel._getObject.apply(this.oModel, arguments);
	};

	ODataMetaModel.prototype.bindContext = function (sPath, oContext, mParameters) {
		return new ClientContextBinding(this, sPath, oContext, mParameters);
	};

	ODataMetaModel.prototype.bindList = function (sPath, oContext, aSorters, aFilters,
			mParameters) {
		return new JSONListBinding(this, sPath, oContext, aSorters, aFilters, mParameters);
	};

	ODataMetaModel.prototype.bindProperty = function (sPath, oContext, mParameters) {
		return new JSONPropertyBinding(this, sPath, oContext, mParameters);
	};

	ODataMetaModel.prototype.bindTree = function (sPath, oContext, aFilters, mParameters) {
		return new JSONTreeBinding(this, sPath, oContext, aFilters, mParameters);
	};

	ODataMetaModel.prototype.destroy = function () {
		MetaModel.prototype.destroy.apply(this, arguments);
		return this.oModel.destroy.apply(this.oModel, arguments);
	};

	/**
	 * Returns the OData meta model context corresponding to the given OData model path.
	 *
	 * @param {string} sPath
	 *   an absolute path pointing to an entity or property, e.g.
	 *   "/ProductSet(1)/ToSupplier/BusinessPartnerID"; this equals the
	 *   <a href="http://www.odata.org/documentation/odata-version-2-0/uri-conventions#ResourcePath">
	 *   resource path</a> component of a URI according to OData v2 URI conventions
	 * @returns {sap.ui.model.Context}
	 *   the context for the corresponding meta data object, i.e. an entity type or its property
	 * @throws {Error} in case no context can be determined
	 * @public
	 */
	ODataMetaModel.prototype.getMetaContext = function (sPath) {
		var i,
			oAssocationEnd,
			oEntitySet,
			oEntityType,
			sMetaPath,
			sNavigationPropertyName,
			aParts = sPath.split("/"),
			iPropertyIndex,
			sQualifiedName;

		/*
		 * Strips the OData key predicate from a resource path segment.
		 *
		 * @param {string} sSegment
		 * @returns {string}
		 */
		function stripKeyPredicate(sSegment) {
			var iPos = sSegment.indexOf("(");
			return iPos >= 0
				? sSegment.slice(0, iPos)
				: sSegment;
		}

		if (aParts[0] !== "") {
			throw new Error("Not an absolute path: " + sPath);
		}

		// from entity set to entity type
		oEntitySet = this.getODataEntitySet(stripKeyPredicate(aParts[1]));
		if (!oEntitySet) {
			throw new Error("Entity set not found: " + aParts[1]);
		}
		sQualifiedName = oEntitySet.entityType;

		// follow (navigation) properties
		for (i = 2; i < aParts.length; i += 1) {
			oEntityType = this.getODataEntityType(sQualifiedName);
			sNavigationPropertyName = stripKeyPredicate(aParts[i]);
			oAssocationEnd = this.getODataAssociationEnd(oEntityType, sNavigationPropertyName);

			if (oAssocationEnd) {
				// navigation property
				sQualifiedName = oAssocationEnd.type;
				if (oAssocationEnd.multiplicity === "1" && sNavigationPropertyName !== aParts[i]) {
					// key predicate not allowed here
					throw new Error("Multiplicity is 1: " + aParts[i]);
				}
			} else {
				// structural property
				iPropertyIndex = findIndex(oEntityType.property, aParts[i]);
				if (iPropertyIndex < 0) {
					throw new Error("(Navigation) Property not found: " + aParts[i]);
				}
				sMetaPath = this.getODataEntityType(sQualifiedName, true)
					+ "/property/" + iPropertyIndex;

				// complex property type is not supported yet
				if (i + 1 < aParts.length) {
					throw new Error("Unsupported: " + sPath);
				}
				break;
			}
		}

		sMetaPath = sMetaPath || this.getODataEntityType(sQualifiedName, true);
		return this.createBindingContext(sMetaPath);
	};

	/**
	 * Returns the OData association end corresponding to the given entity type's navigation
	 * property of given name.
	 *
	 * @param {object} oEntityType
	 *   an entity type as returned by {@link #getODataEntityType getODataEntityType}
	 * @param {string} sName
	 *   the name of a navigation property within this entity type
	 * @returns {object}
	 *   the OData association end or <code>null</code> if no such association end is found
	 * @public
	 */
	ODataMetaModel.prototype.getODataAssociationEnd = function (oEntityType, sName) {
		var oNavigationProperty = oEntityType
				? findObject(oEntityType.navigationProperty, sName)
				: null,
			oAssociation = oNavigationProperty
				? getPathOrObject(this.oModel, "association", oNavigationProperty.relationship)
				: null,
			oAssociationEnd = oAssociation
				? findObject(oAssociation.end, oNavigationProperty.toRole, "role")
				: null;

		return oAssociationEnd;
	};

	/**
	 * Returns the OData entity set with the given simple name from the default entity container.
	 *
	 * @param {string} sName
	 *   a simple name, e.g. "ProductSet"
	 * @returns {object}
	 *   the entity set with the given simple name; or <code>null</code> if no such set is found
	 * @public
	 */
	ODataMetaModel.prototype.getODataEntitySet = function (sName) {
		var oEntitySet = null;

		jQuery.each(this.oModel.getObject("/dataServices/schema") || [], function (i, oSchema) {
			var oEntityContainer
				= findObject(oSchema.entityContainer, "true", "isDefaultEntityContainer");
			if (oEntityContainer) {
				oEntitySet = findObject(oEntityContainer.entitySet, sName);
				return false; //break
			}
		});

		return oEntitySet;
	};

	/**
	 * Returns the OData entity type with the given qualified name, either as a path or as an
	 * object, as indicated.
	 *
	 * @param {string} sQualifiedName
	 *   a qualified name, e.g. "ACME.Product"
	 * @param {boolean} [bAsPath=false]
	 *   determines whether the entity type is returned as a path or as an object
	 * @returns {object|string}
	 *   (the path to) the entity type with the given qualified name; <code>undefined</code> (for a
	 *   path) or <code>null</code> (for an object) if no such type is found
	 * @public
	 */
	ODataMetaModel.prototype.getODataEntityType = function (sQualifiedName, bAsPath) {
		return getPathOrObject(this.oModel, "entityType", sQualifiedName, bAsPath);
	};

	ODataMetaModel.prototype.getProperty = function () {
		return this.oModel.getProperty.apply(this.oModel, arguments);
	};

	ODataMetaModel.prototype.isList = function () {
		return this.oModel.isList.apply(this.oModel, arguments);
	};

	/**
	 * Returns a promise which is fulfilled once the meta model data is loaded and can be used.
	 * It is rejected with a corresponding <code>Error</code> object in case of errors, such as
	 * failure to load meta data or annotations.
	 *
	 * @public
	 * @returns {Promise} a Promise
	 */
	ODataMetaModel.prototype.loaded = function(){
		return this.oLoadedPromise;
	};

	/**
	 * Refresh not supported by OData meta model!
	 *
	 * @throws {Error}
	 * @returns {void}
	 * @public
	 */
	ODataMetaModel.prototype.refresh = function () {
		throw new Error("Unsupported operation: ODataMetaModel#refresh");
	};

	/**
	 * Legacy syntax not supported by OData meta model!
	 *
	 * @param {boolean} bLegacySyntax
	 *   must not be true!
	 * @throws {Error} if <code>bLegacySyntax</code> is true
	 * @returns {void}
	 * @public
	 */
	ODataMetaModel.prototype.setLegacySyntax = function (bLegacySyntax) {
		if (bLegacySyntax) {
			throw new Error("Legacy syntax not supported by ODataMetaModel");
		}
	};

	/**
	 * Changes not supported by OData meta model!
	 *
	 * @throws {Error}
	 * @returns {void}
	 * @private
	 */
	ODataMetaModel.prototype.setProperty = function () {
		// Note: this method is called by JSONPropertyBinding#setValue
		throw new Error("Unsupported operation: ODataMetaModel#setProperty");
	};

	return ODataMetaModel;
}, /* bExport= */ true);