////////////////////////////////////////////////////////////////////////////////
/// DISCLAIMER
///
/// Copyright 2017-2017 ArangoDB GmbH, Cologne, Germany
/// Copyright 2017-2017 triAGENS GmbH, Cologne, Germany
///
/// Licensed under the Apache License, Version 2.0 (the "License");
/// you may not use this file except in compliance with the License.
/// You may obtain a copy of the License at
///
///     http://www.apache.org/licenses/LICENSE-2.0
///
/// Unless required by applicable law or agreed to in writing, software
/// distributed under the License is distributed on an "AS IS" BASIS,
/// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
/// See the License for the specific language governing permissions and
/// limitations under the License.
///
/// Copyright holder is ArangoDB GmbH, Cologne, Germany
///
/// @author Max Neunhoeffer
////////////////////////////////////////////////////////////////////////////////

#ifndef ARANGOD_TRANSACTION_TRANSACTION_PROXY_H
#define ARANGOD_TRANSACTION_TRANSACTION_PROXY_H 1

#include "Basics/Common.h"
#include "RestServer/TransactionRegistryFeature.h"
#include "Utils/CollectionNameResolver.h"
#include "Transaction/Context.h"
#include "Transaction/Methods.h"
#include "Transaction/TransactionRegistry.h"
#include "Utils/SingleCollectionTransaction.h"

namespace arangodb {
namespace transaction {

class SingleCollectionTransactionProxy {

  // The purpose of this class is to be a wrapper around a pointer to a
  // SingleCollectionTransaction. The constructors are exactly as for that
  // class. Our constructors here decide whether we use an already ongoing
  // transaction that has been created outside, or whether we open a new
  // transaction. The destructor behaves accordingly and either returns
  // the transaction to the transaction registry or destroys it.

 public:
  //////////////////////////////////////////////////////////////////////////////
  /// @brief create the transaction, using a collection id
  //////////////////////////////////////////////////////////////////////////////

  SingleCollectionTransactionProxy(
      std::shared_ptr<transaction::Context> const& context,
      TRI_voc_cid_t cid, AccessMode::Type accessType) {
    TransactionId parent = context->getParentTransaction();
    if (parent != TransactionId::ZERO) {
      Methods* trx = Methods::open(parent, context->vocbase());
      // Note that the open call throws an exception if the registry does
      // not have the transaction or if it is already in use.
      _trx = static_cast<SingleCollectionTransaction*>(trx);
      _wasCreatedHere = false;
      // add the (sole) collection:
      _trx->addCollection(cid, accessType);
    } else {
      _trx = new SingleCollectionTransaction(context, cid, accessType);
      _wasCreatedHere = true;
    }
  }

  //////////////////////////////////////////////////////////////////////////////
  /// @brief create the transaction, using a collection name
  //////////////////////////////////////////////////////////////////////////////

  SingleCollectionTransactionProxy(
      std::shared_ptr<transaction::Context> const& context,
      std::string const& name, AccessMode::Type accessType) {
    TransactionId parent = context->getParentTransaction();
    if (parent != TransactionId::ZERO) {
      auto trxReg = TransactionRegistryFeature::TRANSACTION_REGISTRY;
      Methods* trx = trxReg->open(parent, context->vocbase());
      // Note that the open call throws an exception if the registry does
      // not have the transaction or if it is already in use.
      _trx = static_cast<SingleCollectionTransaction*>(trx);
      _wasCreatedHere = false;
      // add the (sole) collection
      TRI_voc_cid_t cid = _trx->resolver()->getCollectionId(name);
      _trx->addCollection(cid, name.c_str(), accessType);
    } else {
      _trx = new SingleCollectionTransaction(context, name, accessType);
      _wasCreatedHere = true;
    }
  }

  //////////////////////////////////////////////////////////////////////////////
  /// @brief end the transaction
  //////////////////////////////////////////////////////////////////////////////

  ~SingleCollectionTransactionProxy() {
    if (_wasCreatedHere) {
      delete _trx;
    } else {
      _trx->close();
    }
  }

  //////////////////////////////////////////////////////////////////////////////
  /// @brief forward the arrow
  //////////////////////////////////////////////////////////////////////////////

  SingleCollectionTransaction* operator->() const {
    return _trx;
  }

  //////////////////////////////////////////////////////////////////////////////
  /// @brief get actual transaction
  //////////////////////////////////////////////////////////////////////////////

  SingleCollectionTransaction* get() const {
    return _trx;
  }

 private:

  SingleCollectionTransaction* _trx;
  bool _wasCreatedHere;

};

}  // namespace arangodb::transaction
}  // namespace arangodb
#endif
